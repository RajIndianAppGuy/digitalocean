import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import axios from "axios";
import {
  checkEmbaddingExists,
  deleteEmbeddingsBySlug,
  storeEmbadding,
  storeTextInfo,
  updateTextInfo,
} from "../supabase/tables.js";
import TokenTracker from "../utils/tokenTracker.js";

function generateSlug() {
  return (
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 10) +
    Date.now().toString(36) +
    Date.now()
  );
}

async function generateEmbeddingWithRetry(text, tokenTracker, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await axios.post(
        "https://api.openai.com/v1/embeddings",
        {
          input: text,
          model: "text-embedding-3-small",
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_KEY}`,
          },
        }
      );

      // Track token usage from the actual API response
      if (response.data.usage) {
        console.log("Adding usage to token tracker:", response.data.usage);
        tokenTracker.addUsage(
          {
            data: {
              usage: {
                prompt_tokens: response.data.usage.prompt_tokens,
                completion_tokens: 0,
                total_tokens: response.data.usage.total_tokens,
              },
            },
          },
          "text-embedding-3-small"
        );
      } else {
        console.log("No usage data in OpenAI response");
      }

      return response.data.data[0].embedding;
    } catch (error) {
      console.error("Error in generateEmbeddingWithRetry:", error);
      if (i === maxRetries - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}

async function processBatchWithTimeout(batch, slug, timestamp, tokenTracker, retries = 7) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    console.log(`Starting batch processing attempt ${attempt}/${retries}`);
    
    // Create a timeout promise that rejects after 2 minutes
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Batch processing timed out after 2 minutes (attempt ${attempt})`));
      }, 180000); // 3 minutes in milliseconds
    });

    // Create the batch processing promise
    const batchProcessingPromise = (async () => {
      let totalChars = 0;
      const embeddings = [];
      
      const chunkEmbeddings = await Promise.all(
        batch.map(async (doc, i) => {
          console.log(`Generating embedding for chunk: ${i}`);
          const embedding = await generateEmbeddingWithRetry(
            doc.pageContent,
            tokenTracker
          );
          totalChars += doc.pageContent.length;
          return {
            slug: slug,
            timestamp: timestamp,
            content: doc.pageContent,
            embedding: embedding,
            metadata: doc.metadata,
          };
        })
      );
      
      embeddings.push(...chunkEmbeddings);
      return embeddings;
    })();

    try {
      // Race between the batch processing and the timeout
      const result = await Promise.race([batchProcessingPromise, timeoutPromise]);
      console.log(`Batch processing completed successfully on attempt ${attempt}`);
      return result;
    } catch (error) {
      console.error(`Batch processing attempt ${attempt} failed:`, error.message);
      
      if (attempt === retries) {
        throw new Error(`All ${retries} attempts to process batch failed`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

export default async function embedController(req, res) {
  const tokenTracker = new TokenTracker();

  try {
    const startTime = Date.now();
    const { url, content, initial } = req.body;
    let text;

    const isEmbeddingExist = await checkEmbaddingExists(url);

    if (isEmbeddingExist !== null) {
      return res.status(200).json({
        status: "success",
        message: "Page already embedded",
        slug: isEmbeddingExist[0].slug,
      });
    }

    let success = false;
    const maxAttempts = 3;
    let attempt = 0;

    if (url && initial) {
      while (attempt < maxAttempts && !success) {
        try {
          console.log(`🚀 Attempt ${attempt + 1} to scrape URL...`);

          const response = await axios.get(
            "https://app.scrapingbee.com/api/v1",
            {
              params: {
                api_key: process.env.SCRAPING_API_KEY,
                url,
                render_js: true,
                block_ads: true,
                wait: 20000,
              },
              timeout: 80000,
            }
          );

          text = response.data;
          console.log(`✅ Scraping succeeded on attempt ${attempt + 1}`);
          success = true;
        } catch (error) {
          console.error(`❌ Attempt ${attempt + 1} failed: ${error.message}`);
          attempt++;

          if (attempt < maxAttempts) {
            console.log(`⏳ Waiting 10 seconds before retrying...`);
            await new Promise((resolve) => setTimeout(resolve, 10000));
          } else {
            console.error(`❌ All ${maxAttempts} attempts failed. Exiting.`);
            throw error;
          }
        }
      }
    } else {
      text = content;
      console.log(`📄 Using static content instead of scraping`);
    }

    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 500,
      chunkOverlap: 50,
      separators: ["\n\n", "\n", " ", ""],
    });

    let output = await splitter.createDocuments([text]);

    const slug = generateSlug();
    console.log("Slug: ", slug);

    const timestamp = new Date().toISOString();
    console.log("Timestamp: ", timestamp);

    console.log("Generating embeddings");
    const embeddings = [];

    if (output.length <= 500) {
      // Process small batches in parallel
      console.log("Processing small batch in parallel");
      const parallelEmbeddings = await Promise.all(
        output.map(async (doc, i) => {
          console.log("Generating embedding for chunk: ", i);
          const embedding = await generateEmbeddingWithRetry(
            doc.pageContent,
            tokenTracker
          );
          return {
            slug: slug,
            timestamp: timestamp,
            content: doc.pageContent,
            embedding: embedding,
            metadata: doc.metadata,
          };
        })
      );
      embeddings.push(...parallelEmbeddings);
    } else {
      // Process large batches in chunks of 300 with timeout and retries
      console.log("Processing large batch in chunks of 300");
      const chunkSize = 300;
      const totalChunks = Math.ceil(output.length / chunkSize);

      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        console.log(`Processing chunk ${chunkIndex + 1} of ${totalChunks}`);
        const start = chunkIndex * chunkSize;
        const end = Math.min(start + chunkSize, output.length);
        const currentChunk = output.slice(start, end);

        try {
          const chunkEmbeddings = await processBatchWithTimeout(
            currentChunk,
            slug,
            timestamp,
            tokenTracker
          );
          embeddings.push(...chunkEmbeddings);
        } catch (error) {
          console.error(`Failed to process chunk ${chunkIndex + 1}:`, error.message);
          throw error;
        }
      }
    }

    // Get token usage from the tracker
    const tokenUsage = tokenTracker.getUsage();
    console.log("Final Token Usage:", tokenUsage);

    console.log("Storing embeddings");
    await Promise.all(
      embeddings.map(async (embedding, index) => {
        await storeEmbadding(embedding);
      })
    );

    const urlInfo = {
      slug: slug,
      url,
    };

    if (isEmbeddingExist != null) {
      await updateTextInfo(isEmbeddingExist[0].slug, slug);
    } else {
      await storeTextInfo(urlInfo);
    }

    const totalTime = (Date.now() - startTime) / 1000;
    console.log(
      `Total time taken for embedding and storing: ${totalTime} seconds`
    );

    res.status(201).json({
      status: "success",
      message: "Page Embedded successfully",
      slug: slug,
      tokens: tokenUsage.totalTokens,
      cost: tokenUsage.cost,
      totalTime: totalTime,
    });
  } catch (error) {
    console.error("Error processing request:", error);
    return res.status(500).json({
      status: "error",
      message: `Internal server error - ${error.message}`,
    });
  }
}

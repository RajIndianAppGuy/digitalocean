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
        console.log("Adding usage to token tracker:", response.data.usage); // Debug log
        tokenTracker.addUsage({
          data: {
            usage: {
              prompt_tokens: response.data.usage.prompt_tokens,
              completion_tokens: 0,
              total_tokens: response.data.usage.total_tokens
            }
          }
        }, "text-embedding-3-small");
      } else {
        console.log("No usage data in OpenAI response"); // Debug log
      }
      
      return response.data.data[0].embedding;
    } catch (error) {
      console.error("Error in generateEmbeddingWithRetry:", error); // Debug log
      if (i === maxRetries - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1))); // Exponential backoff
    }
  }
}

export default async function embedController(req, res) {
  const tokenTracker = new TokenTracker(); // Create new instance for this request
  
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

    if (url && initial) {
      const response = await axios.get("https://app.scrapingbee.com/api/v1", {
        params: {
          api_key: process.env.SCRAPING_API_KEY,
          url,
          render_js: true,
          block_ads: true,
          wait: 5000,
        },
        timeout: 80000,
      });
      text = response.data;
      console.log(`Generating data for URL`);
    } else {
      text = content;
      console.log(`Generating data for content`);
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
    let totalChars = 0;
    console.log("Output: ", output.length);
    const embeddings = [];
    
    if (output.length <= 500) {
      // Process small batches in parallel
      console.log("Processing small batch in parallel");
      const parallelEmbeddings = await Promise.all(
        output.map(async (doc, i) => {
          console.log("Generating embedding for chunk: ", i);
          const embedding = await generateEmbeddingWithRetry(doc.pageContent, tokenTracker);
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
      embeddings.push(...parallelEmbeddings);
    } else {
      // Process large batches in chunks of 300
      console.log("Processing large batch in chunks of 300");
      const chunkSize = 300;
      const totalChunks = Math.ceil(output.length / chunkSize);
      
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        console.log(`Processing chunk ${chunkIndex + 1} of ${totalChunks}`);
        const start = chunkIndex * chunkSize;
        const end = Math.min(start + chunkSize, output.length);
        const currentChunk = output.slice(start, end);
        
        // Process current chunk in parallel
        const chunkEmbeddings = await Promise.all(
          currentChunk.map(async (doc, i) => {
            const actualIndex = start + i;
            console.log(`Generating embedding for chunk: ${actualIndex}`);
            const embedding = await generateEmbeddingWithRetry(doc.pageContent, tokenTracker);
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
    console.log(`Total time taken for embedding and storing: ${totalTime} seconds`);

    res.status(201).json({
      status: "success",
      message: "Page Embedded successfully",
      slug: slug,
      tokens: tokenUsage.totalTokens,
      cost: tokenUsage.cost,
      totalTime: totalTime
    });
  } catch (error) {
    console.error("Error processing request:", error);
    return res.status(500).json({
      status: "error",
      message: `Internal server error - ${error.message}`,
    });
  }
}

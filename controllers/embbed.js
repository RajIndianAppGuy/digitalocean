import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import axios from "axios";
import {
  checkEmbaddingExists,
  deleteEmbeddingsBySlug,
  storeEmbadding,
  storeTextInfo,
  updateTextInfo,
} from "../supabase/tables.js";
import tokenTracker from "../utils/tokenTracker.js";

function generateSlug() {
  return (
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 10) +
    Date.now().toString(36) +
    Date.now()
  );
}

async function generateEmbeddingWithRetry(text, maxRetries = 5) {
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
      return response.data.data[0].embedding;
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1))); // Exponential backoff
    }
  }
}

export default async function embedController(req, res) {
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
          const embedding = await generateEmbeddingWithRetry(doc.pageContent);
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
            const embedding = await generateEmbeddingWithRetry(doc.pageContent);
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

    const estimatedTokens = Math.round(totalChars / 4); // Approx 4 chars = 1 token
    const estimatedCost = (estimatedTokens / 1000) * 0.0001;

    // Add embedding tokens to the token tracker
    tokenTracker.addUsage({
      data: {
        usage: {
          prompt_tokens: estimatedTokens,
          completion_tokens: 0,
          total_tokens: estimatedTokens
        }
      }
    }, "ext-embedding-3-small");

    console.log("Total Chars:", totalChars);
    console.log("Estimated Tokens:", estimatedTokens);
    console.log("Estimated Cost ($):", estimatedCost.toFixed(6));

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
      tokens: estimatedTokens,
      cost: estimatedCost.toFixed(6),
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

import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import axios from "axios";
import {
  checkEmbaddingExists,
  deleteEmbeddingsBySlug,
  storeEmbadding,
  storeTextInfo,
  updateTextInfo,
} from "../supabase/tables.js";

function generateSlug() {
  return (
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 10) +
    Date.now().toString(36) +
    Date.now()
  );
}

async function generateEmbeddingWithRetry(text, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await axios.post(
        "https://api.openai.com/v1/embeddings",
        {
          input: text,
          model: "text-embedding-ada-002",
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

async function batchStoreEmbeddingsWithRateLimit(
  embeddings,
  initialBatchSize = 10,
  initialDelayMs = 1000
) {
  let batchSize = initialBatchSize;
  let delayMs = initialDelayMs;

  for (let i = 0; i < embeddings.length; i += batchSize) {
    const batch = embeddings.slice(i, i + batchSize);

    try {
      await Promise.all(batch.map(storeEmbadding));
      console.log(`Stored batch ${Math.floor(i / batchSize) + 1}`);

      batchSize = Math.min(batchSize + 1, 50);
      delayMs = Math.max(delayMs - 100, 500);
    } catch (error) {
      console.error(
        `Error storing batch ${Math.floor(i / batchSize) + 1}:`,
        error
      );

      if (error.message.includes("rate limit")) {
        batchSize = Math.max(Math.floor(batchSize / 2), 1);
        delayMs = delayMs * 2;
        i -= batchSize;
        console.log(
          `Adjusted batch size to ${batchSize} and delay to ${delayMs}ms`
        );
      } else {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

export default async function embedController(req, res) {
  try {
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
    const embeddings = await Promise.all(
      output.map(async (doc) => {
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

    const estimatedTokens = Math.round(totalChars / 4); // Approx 4 chars = 1 token
    const estimatedCost = (estimatedTokens / 1000) * 0.0001;

    console.log("Total Chars:", totalChars);
    console.log("Estimated Tokens:", estimatedTokens);
    console.log("Estimated Cost ($):", estimatedCost.toFixed(6));

    console.log("Storing embeddings");
    await batchStoreEmbeddingsWithRateLimit(embeddings);

    const urlInfo = {
      slug: slug,
      url,
    };

    if (isEmbeddingExist != null) {
      await updateTextInfo(isEmbeddingExist[0].slug, slug);
    } else {
      await storeTextInfo(urlInfo);
    }

    res.status(201).json({
      status: "success",
      message: "Page Embedded successfully",
      slug: slug,
      tokens: estimatedTokens,
      cost: estimatedCost.toFixed(6),
    });
  } catch (error) {
    console.error("Error processing request:", error);
    return res.status(500).json({
      status: "error",
      message: `Internal server error - ${error.message}`,
    });
  }
}

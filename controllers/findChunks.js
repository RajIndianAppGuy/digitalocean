import { OpenAIEmbeddings } from "@langchain/openai";
import { checkSlug, checkEmbadding } from "../supabase/tables.js";

export default async function searchController(req, res) {
  try {
    // check it is post request or not
    if (req.method !== "POST") {
      return res.status(405).json({
        status: "error",
        message: `Method ${req.method} not allowed`,
      });
    }

    const { text, slug } = req.body;

    if (!text || !slug) {
      return res.status(400).json({
        status: "error",
        message: "Please enter valid fields",
      });
    }

    // Check slug is present or not
    const slugData = await checkSlug(slug);
    if (!slugData || slugData.length === 0) {
      return res.status(400).json({
        status: "error",
        message: "No data found for the provided slug",
      });
    }

    // Get Embedding of the text
    const embedding = new OpenAIEmbeddings({
      apiKey: process.env.OPENAI_KEY,
    });

    try {
      const embeddedResponse = await embedding.embedQuery(text);
      
      // Search in Supabase
      const searchData = await checkEmbadding(embeddedResponse, slug);

      // Check if the search data is empty or not
      if (!searchData || searchData.length === 0) {
        return res.status(404).json({
          status: "error",
          message: "No matching content found for the search text",
        });
      }

      // Fetch all the content of slugs
      let fetchedContent = "";
      searchData.forEach((item) => {
        fetchedContent += item.content;
      });

      return res.status(200).json({
        status: "success",
        message: "Retrieve successful",
        data: fetchedContent,
      });
    } catch (embeddingError) {
      console.error("Error in embedding or search:", embeddingError);
      return res.status(500).json({
        status: "error",
        message: `Error processing search: ${embeddingError.message}`,
        details: embeddingError
      });
    }
  } catch (error) {
    console.error("Error in searchController:", error);
    return res.status(500).json({
      status: "error",
      message: `Internal server error: ${error.message}`,
      details: error
    });
  }
}

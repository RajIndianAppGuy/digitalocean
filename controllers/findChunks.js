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
    if (slugData.length === 0) {
      return res.status(400).json({
        status: "true",
        message: "Please enter a valid slug",
      });
    }

    // Get Embedding of the text
    const embedding = new OpenAIEmbeddings({
      apiKey: process.env.OPENAI_KEY,
    });

    const embeddedResponse = await embedding.embedQuery(text);
    // console.log("Embedded Response: ", embeddedResponse);

    // Search in Supabase
    const searchData = await checkEmbadding(embeddedResponse, slug);
    // console.log("Search Data: ", searchData);

    // Check if the search data is empty or not
    if (!searchData || searchData.length === 0) {
      return res.status(400).json({
        status: "error",
        message: "Retrieve not possible",
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
  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: `Internal server error at searchController: ${error}`,
    });
  }
}

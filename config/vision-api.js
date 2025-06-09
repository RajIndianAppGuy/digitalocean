import axios from "axios";
import tokenTracker from "../utils/tokenTracker.js";

export async function analyzeScreenshot(screenshotUrl, question) {
  question =
    question + "only answer in true or false dont elaborate your answer";
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: question },
              { type: "image_url", image_url: { url: screenshotUrl } },
            ],
          },
        ],
        max_tokens: 300,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_KEY}`,
        },
      }
    );

    // Track token usage with image costs
    tokenTracker.addUsage(response, "gpt-4o", true);

    if (
      response.data &&
      response.data.choices &&
      response.data.choices.length > 0
    ) {
      return response.data.choices[0].message.content;
    } else {
      throw new Error("Unexpected response structure from OpenAI API");
    }
  } catch (error) {
    console.error("Error analyzing screenshot:", error);
    throw error;
  }
}

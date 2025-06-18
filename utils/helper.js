import axios from "axios";
import TokenTracker from "./tokenTracker.js";
import {
  CreateErrorExplanationFunction,
  CreatePlaywrightSelector,
  extensionMessageToOpenAI,
  userMessageToOpenAI,
} from "./prompt.js";

import openai from "../config/openai.js"; // Assuming this is your OpenAI client instance

export async function getUserFriendlyErrorMessage(rawErrorText, tokenTracker = null) {
  const model = process.env.OPENAI_MODEL || "gpt-4o";
  const openaiKey = process.env.OPENAI_KEY;

  const functionTool = CreateErrorExplanationFunction();

  const prompt = `This is a technical error from an automated test. Please explain it in a user-friendly way:\n"${rawErrorText}"`;

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: model,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      functions: [functionTool],
      function_call: { name: "generate_user_friendly_error" },
      temperature: 0.7,
      max_tokens: 300,
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
    }
  );

  const resultArgs = response.data.choices[0].message.function_call.arguments;

  if (tokenTracker) {
    tokenTracker.addUsage(response, model, true, {
      type: "Error Explanation",
      description: rawErrorText.slice(0, 50) + "...",
    });
  }

  const parsed = JSON.parse(resultArgs);
  return parsed.explanation;
}


export const getSelector = async (step, name, screenshotUrl, err, tokenTracker, stepInfo = null) => {
  let userMessage = userMessageToOpenAI(step, step.chunk, name, err);

  const funcitonTools = CreatePlaywrightSelector();
  const model = process.env.OPENAI_MODEL || "gpt-4o"; // Default to gpt-4o if not specified
  
  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: userMessage },
            { type: "image_url", image_url: { url: screenshotUrl } },
          ],
        },
      ],
      functions: [funcitonTools],
      function_call: { name: "create_playwright_selector_json" },
      max_tokens: 300,
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_KEY}`,
      },
    }
  );
  
  // Track token usage with step information
  tokenTracker.addUsage(response, model, true, stepInfo);
  
  console.log(
    "got this selector ==============================>",
    response.data.choices[0].message.function_call.arguments
  );
  return JSON.parse(response.data.choices[0].message.function_call.arguments);
};


export const getExtensionSelector = async (element, tokenTracker, stepInfo = null) => {
  let userMessage = extensionMessageToOpenAI(element);
  console.log("User Message---", userMessage);

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: userMessage,
      },
    ],
  });
  
  // Track token usage with step information
  tokenTracker.addUsage(completion, "gpt-4o", false, stepInfo);
  
  console.log("Response: ", completion.choices[0].message.content);

  return completion.choices[0].message.content;
};
export async function getFullyRenderedContent(url) {
  try {
    const response = await axios.get("https://app.scrapingbee.com/api/v1", {
      params: {
        api_key: process.env.SCRAPING_API_KEY,
        url,
        // Optional parameters
        render_js: true, // Set to true if you want to render JavaScript on the page
        block_ads: true, // Block ads to speed up the scraping
        wait: 5000,
      },
    });

    return response.data;

    // Output the scraped content
    console.log("Scraped HTML:", response.data);
  } catch (error) {
    console.error("Error scraping website:", error);
  }
}

export function stepToString(steps, id) {
  const executionId = id;
  const resultString = steps
    .filter((action) => action.id < executionId)
    .map((action) => {
      if (action.actionType === "Click Element") {
        return `Clicked on the element "${action.details.element}".`;
      } else if (action.actionType === "Fill Input") {
        return `Filled the "${action.details.description}" field with data.`;
      }
    })
    .join(" ");

  console.log("Result String: ", resultString);
  return resultString;
}

export function extractPath(selector) {
  const regex = /'\/([^']*)'/;
  const match = selector.match(regex);
  return match ? `/${match[1]}` : "";
}

export function updateCurrentUrl(currentUrl, selector) {
  const path = extractPath(selector);

  // check if currentUrl contain / at the end then remove / from path then add path to currentUrl
  if (currentUrl.endsWith("/")) {
    return currentUrl.slice(0, -1) + path;
  }

  return currentUrl + path;
}

export async function highlightElement(page, selector, color = "red") {
  try {
    // Locate the element using a text selector like 'text="sign in"'
    const elementHandle = await page.locator(selector).elementHandle();

    if (elementHandle) {
      // Highlight and scroll the element
      await page.evaluate(
        ({ element, color }) => {
          element.style.outline = `2px solid ${color}`;
          element.scrollIntoView({ behavior: "smooth", block: "center" });
        },
        { element: elementHandle, color }
      );
    } else {
      throw new Error(`Element with selector "${selector}" not found`);
    }
  } catch (error) {
    console.error(`Error in highlightElement: ${error.message}`);
    return false;
  }

  return true;
}

import axios from "axios";
import TokenTracker from "./tokenTracker.js";
import {
  CreatePlaywrightSelector,
  extensionMessageToOpenAI,
  userMessageToOpenAI,
} from "./prompt.js";
import openai from "../config/openai.js";

export const getSelector = async (step, name, screenshotUrl, err, tokenTracker) => {
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
  
  // Track token usage
  tokenTracker.addUsage(response, model, true);
  
  console.log(
    "got this selector ==============================>",
    response.data.choices[0].message.function_call.arguments
  );
  return JSON.parse(response.data.choices[0].message.function_call.arguments);
};


export const getExtensionSelector = async (element) => {
  let userMessage = extensionMessageToOpenAI(element);
  console.log("User Message---", userMessage);

  // const funcitonTools = CreatePlaywrightSelector();
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: userMessage,
      },
    ],
    // tools: [
    //   {
    //     type: "function",
    //     function: funcitonTools,
    //   },
    // ],
  });
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

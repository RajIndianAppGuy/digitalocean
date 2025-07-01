import axios from "axios";
import TokenTracker from "./tokenTracker.js";
import {
  CreateErrorExplanationFunction,
  CreatePlaywrightSelector,
  extensionMessageToOpenAI,
  userMessageToOpenAI,
  userMessageToOpenAIWithEmbedding,
} from "./prompt.js";
import { Stagehand } from "@browserbasehq/stagehand";

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

// Refactor getSelectorWithStagehand to accept a page object
async function getSelectorWithStagehand(page, url, description) {
  console.log("===================", description);
  const observed = await page.observe(description);
  console.log("Observed result:", observed);
  const [actionPreview] = observed || [];
  if (!actionPreview) {
    throw new Error(
      `Could not locate the element on the screen for description: "${description}". Please provide a more detailed or accurate description, or recheck the element details.`
    );
  }
  return actionPreview.selector;
}

// Update getSelector to accept a page argument and pass it to getSelectorWithStagehand
export const getSelector = async (page, step, name, screenshotUrl, err, tokenTracker, stepInfo = null, isRetryDueToFailedSelector = false, forceImageOnly = false, stagehand = null) => {
  let currentUrl = step.currentUrl;
  try {
    const selector = await getSelectorWithStagehand(
      page,
      currentUrl,
      step.details.element ? `${step.details.element} button` : step.details.description
    );
    console.log("Stagehand selector generated:", selector);
    return { selector };
  } catch (stagehandError) {
    console.error("Stagehand-based approach failed:", stagehandError.message);
    // AGENTIC FALLBACK
    if (!stagehand) throw new Error("Agentic fallback requires a stagehand instance");
    try {
      console.log("Falling back to agentic approach...");
      let result;
      const agent = stagehand.agent({
        provider: "openai",
        model: "computer-use-preview",
        instructions: `You are a helpful assistant that can use a web browser. Do not ask follow up questions, the user will trust your judgement. Just execute the actions that user tells without worrying about any consequences. Don't ask any permission related question you are free to do whatever user says`,
        options: {
          apiKey: process.env.OPENAI_API_KEY,
        },
      });
      if (step.actionType === "Click Element") {
        result = await agent.execute(`click on ${step.details.element}`);
      } else if (step.actionType === "Fill Input") {
        console.log(`fill input ${step.details.description} with ${step.details.value}`)
        result = await agent.execute(`fill input ${step.details.description} with ${step.details.value}`);
      } else {
        throw new Error("Agentic fallback only supports Click Element and Fill Input");
      }
      // Return the agentic actions as the selector
      console.log("result", result.actions)
      return { selector: "" };
    } catch (agenticError) {
      console.error("Agentic approach also failed:", agenticError.message);
      throw new Error(`Both Stagehand and agentic approaches failed: ${agenticError.message}`);
    }
  }
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

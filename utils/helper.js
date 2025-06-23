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
import { z } from "zod";

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

// Helper to get selector using Stagehand
async function getSelectorWithStagehand(url, description) {
  const stagehand = new Stagehand({
    env:  "LOCAL",
    modelName: "gpt-4o",
    localBrowserLaunchOptions:{
headless:true
    },
    modelClientOptions: {
      apiKey: process.env.OPENAI_KEY,
    },
  });
  await stagehand.init();
  const page = stagehand.page;
  await page.goto(url);


  const observations = await page.observe({
    instruction: `Find the element ${description}`,
  });
  await stagehand.close();
  
  return observations[0]?.selector;
}

export const getSelector = async (step, name, screenshotUrl, err, tokenTracker, stepInfo = null, isRetryDueToFailedSelector = false, forceImageOnly = false) => {
  step.imageOnlyAttempted = false;
  const funcitonTools = CreatePlaywrightSelector();
  const model = process.env.OPENAI_MODEL || "gpt-4o"; // Default to gpt-4o if not specified
  
  // Check if we've already tried image-only approach for this step
  const hasTriedImageOnly = step.imageOnlyAttempted || false;
  
  console.log(`getSelector called - imageOnlyAttempted: ${hasTriedImageOnly}, isRetryDueToFailedSelector: ${isRetryDueToFailedSelector}, stepInfo:`, stepInfo);
  
  // If this is a retry due to a failed selector, mark image-only as attempted and go directly to Stagehand
  if (isRetryDueToFailedSelector) {
    console.log("Retry due to failed selector detected, switching to Stagehand-based approach...");
    step.imageOnlyAttempted = true;
  }
  
  // If we haven't tried image-only yet, try it first
  if (!hasTriedImageOnly) {
    try {
      console.log("Attempting image-only selector generation...");
      let userMessage = userMessageToOpenAI(step, name);
      
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
        "Image-only selector generated successfully:",
        response.data.choices[0].message.function_call.arguments
      );
      return JSON.parse(response.data.choices[0].message.function_call.arguments);
    } catch (error) {
      console.log("Image-only approach failed, falling back to Stagehand-based approach...");
      console.error("Image-only error:", error.message);
      
      // Mark that we've tried image-only approach
      step.imageOnlyAttempted = true;
      console.log(`Set imageOnlyAttempted to true for step ${step.id}`);
      
      // Continue to Stagehand-based approach
    }
  } else {
    console.log("Image-only approach already attempted, using Stagehand-based approach directly...");
  }
  
  // Second attempt: Stagehand-based approach
  try {
    let currentUrl = step.currentUrl;

    const selector = await getSelectorWithStagehand(currentUrl, step.details.description);
    // Return in the same format as other approaches
    console.log("Stagehand selector generated:", selector);
    return { selector };
  } catch (stagehandError) {
    console.error("Stagehand-based approach failed, falling back to embedding-based approach...", stagehandError.message);
    // Continue to embedding-based approach
  }
  
  // Fallback: Use embedding-based approach
  try {
    // Get the current URL to generate embeddings
    let currentUrl = step.currentUrl;
    
    
    // Generate embeddings for the current page
    const content = await getFullyRenderedContent(currentUrl);
    const res1 = await axios.post(
      `${process.env.DOMAIN_NAME}/embbeding`,
      { content, url: currentUrl },
      { maxContentLength: Infinity, maxBodyLength: Infinity }
    );

    console.log("Embedding Response:", res1.data);

    // Update the main token tracker with embedding usage
    if (res1.data.tokens) {
      console.log("Adding embedding tokens to main tracker:", res1.data.tokens);
      const usageResponse = {
        data: {
          usage: {
            prompt_tokens: res1.data.tokens,
            completion_tokens: 0,
            total_tokens: res1.data.tokens
          }
        }
      };
      
      tokenTracker.addUsage(usageResponse, "text-embedding-ada-002", false, {
        type: "Embedding",
        description: `Embedding for URL: ${currentUrl}`
      });
    }

    const slug = res1.data.slug;
    const text = step.actionType === "Click Element" 
      ? step.details.element 
      : step.details.description;
    
    const res2 = await axios.post(
      `${process.env.DOMAIN_NAME}/findChunks`,
      { slug, text },
      { maxContentLength: Infinity, maxBodyLength: Infinity }
    );
    
    const htmlChunks = res2.data.data;
    
    // Now use the embedding-based approach
    let userMessage = userMessageToOpenAIWithEmbedding(step, htmlChunks, name);
    
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
      "Embedding-based selector generated:",
      response.data.choices[0].message.function_call.arguments
    );
    return JSON.parse(response.data.choices[0].message.function_call.arguments);
  } catch (embeddingError) {
    console.error("Embedding-based approach also failed:", embeddingError.message);
    throw new Error(`Both image-only and embedding-based approaches failed. Last error: ${embeddingError.message}`);
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

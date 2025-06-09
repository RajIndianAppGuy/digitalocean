import axios from "axios";
import { chromium } from "playwright";
import { analyzeScreenshot } from "../config/vision-api.js";
import {
  getFullyRenderedContent,
  getSelector,
  highlightElement,
} from "../utils/helper.js";
import { updateTest, fetchTest } from "../supabase/tables.js";
import tokenTracker from "../utils/tokenTracker.js";

// Deep clone utility function to prevent modifying original arrays
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}



// Capture and store a screenshot
async function captureAndStoreScreenshot(page, testId, stepId) {
  try {
    const screenshotBuffer = await page.screenshot({
      fullPage: false,
      timeout: 300000,
    });
    const base64Screenshot = screenshotBuffer.toString("base64");

    const frontendUrl =
      process.env.FRONTEND_URL || "https://www.browsingbee.com";

    const response = await axios.post(`${frontendUrl}/api/screenshot`, {
      testId,
      stepId,
      screenshotData: base64Screenshot,
    });

    console.log("Screenshot Captured");
    return response.data.screenshotUrl;
  } catch (error) {
    console.error(
      `Error capturing/sending screenshot for step ${stepId}:`,
      error
    );
    throw error;
  }
}

// Execute imported test steps independently
async function executeImportedTest(
  page,
  importedTestId,
  testId,
  logs,
  stepResults
) {
  console.log(`Starting imported test execution ${testId},`);
  const importedTest = await fetchTest(importedTestId);
  if (importedTest) {
    logs.push({
      message: `Executing imported test: ${importedTest.name}`,
      status: "info",
    });

    // Clone the imported test's steps to avoid modifying main test steps
    const clonedImportedSteps = deepClone(importedTest.steps);

    // Execute the imported test's steps independently
    await executeSteps(
      page,
      clonedImportedSteps,
      importedTestId,
      page.url(),
      importedTest.name,
      logs,
      stepResults,
      true
    );

    logs.push({
      message: `Completed imported test: ${importedTest.name}`,
      status: "success",
    });
  } else {
    logs.push({
      message: `Failed to import test: ${importedTestId}`,
      status: "error",
    });
  }
}

// Main function to execute test steps
async function executeSteps(
  page,
  steps,
  testId,
  startUrl,
  name,
  logs,
  screenShots,
  isReusable = false
) {
  let currentUrl = startUrl;
  let count = 0;

  // Use a deep clone of the steps to avoid modifying the original array
  const clonedSteps = deepClone(steps);

  console.log(
    `Starting execution for ${testId} with name ${name} and steps:`,
    clonedSteps
  );

  for (let index = 0; index < clonedSteps.length; index++) {
    const step = clonedSteps[index]; // Access the cloned steps

    console.log("=======================================>", page.url());
    if (page.url().includes("google")) {
      // Email input
      await page.fill('input[type="email"]', "raj@indianappguy.com");
      await page.click('button:has-text("Next")');

      // Wait for password field and fill
      await page.waitForSelector('input[type="password"]', { timeout: 5000 });
      await page.fill('input[type="password"]', "Rajdama@1234");
      await page.click('button:has-text("Next")');

      if (!page.url().includes("magicslides.app")) {
        await page.goto("https://www.magicslides.app/", {
          timeout: 60000,
          waitUntil: "networkidle",
        });
      }
    }
    if (
      page.url() !== currentUrl &&
      count !== 0 &&
      !page.url().includes("google")
    ) {
      currentUrl = page.url();
      try {
        const content = await getFullyRenderedContent(currentUrl);
        const res1 = await axios.post(
          `${process.env.DOMAIN_NAME}/embbeding`,
          { content, url: currentUrl },
          { maxContentLength: Infinity, maxBodyLength: Infinity }
        );

        const slug = res1.data.slug;
        if (
          step.actionType !== "AI Visual Assertion" &&
          step.actionType !== "Delay" &&
          step.actionType !== "Import Reusable Test"
        ) {
          const text =
            step.actionType === "Click Element"
              ? step.details.element
              : step.details.description;
          const res2 = await axios.post(
            `${process.env.DOMAIN_NAME}/findChunks`,
            { slug, text },
            { maxContentLength: Infinity, maxBodyLength: Infinity }
          );
          step.chunk = res2.data.data;
        }
      } catch (error) {
        logs.push({
          message: `Error in updating step: ${error.message}`,
          status: "error",
        });
        throw new Error(`Error in updating step: ${error.message}`);
      }
    } else {
      count++;
    }

    try {
      switch (step.actionType) {
        case "Click Element":
          logs.push({
            message: `Clicking on element: "${step.details.element}"`,
            status: "info",
          });
          const clickImage = await captureAndStoreScreenshot(
            page,
            testId,
            step.id
          );
          if (!step.cache) {
            const initialClickSelector = await getSelector(
              step,
              name,
              clickImage
            );
            step.selector = initialClickSelector.selector;
            delete step.chunk;

            // Update the cloned steps and avoid mutating the original steps array
            console.log(
              `Updating testid ${testId} with cloned steps:`,
              clonedSteps
            );
            await updateTest(testId, clonedSteps); // Update with cloned steps
          }

          await highlightElement(
            page,
            step.selector)
          

          const screenshotUrlBeforeClick = await captureAndStoreScreenshot(
            page,
            testId,
            step.id
          );

          screenShots.push(screenshotUrlBeforeClick);
          await page.locator(step.selector).click()

          await page.waitForTimeout(4000);

          const screenshotUrlAfterClick = await captureAndStoreScreenshot(
            page,
            testId,
            step.id
          );

          screenShots.push(screenshotUrlAfterClick);

          logs.push({
            message: `Element "${step.details.element}" clicked successfully`,
            status: "success",
          });
          break;

        case "Fill Input":
          logs.push({
            message: `Filling input: "${step.details.description}" with value: "${step.details.value}"`,
            status: "info",
          });

          const inputImage = await captureAndStoreScreenshot(
            page,
            testId,
            step.id
          );
          if (!step.cache) {
            const initialFillSelector = await getSelector(
              step,
              name,
              inputImage
            );
            step.selector = initialFillSelector.selector;
            delete step.chunk;

            // Update the cloned steps
            console.log(
              `Updating testid ${testId} with cloned steps:`,
              clonedSteps
            );
            await updateTest(testId, clonedSteps); // Update with cloned steps
          }

          const screenshotUrlbeforeInput = await captureAndStoreScreenshot(
            page,
            testId,
            step.id
          );

            await highlightElement(
            page,
            step.selector)

          screenShots.push(screenshotUrlbeforeInput);



          await page.locator(step.selector).fill(step.details.value);

          const screenshotUrlAfterInput = await captureAndStoreScreenshot(
            page,
            testId,
            step.id
          );

          screenShots.push(screenshotUrlAfterInput);
          logs.push({
            message: `Input "${step.details.description}" filled successfully`,
            status: "success",
          });
          break;

        case "AI Visual Assertion":
          logs.push({
            message: `Performing AI Visual Assertion: "${step.question}"`,
            status: "info",
          });
          const screenshotUrl = await captureAndStoreScreenshot(
            page,
            testId,
            step.id
          );
          const analysisResult = await analyzeScreenshot(
            screenshotUrl,
            step.question
          );
          console.log(analysisResult);
          screenShots.push(screenshotUrl);

          logs.push({ message: `${analysisResult}`, status: "info" });
          break;

        case "Delay":
          logs.push({
            message: `Waiting for ${step.delayTime} milliseconds`,
            status: "info",
          });
          const screenshotUrlBeforeDelay = await captureAndStoreScreenshot(
            page,
            testId,
            step.id
          );
          await page.waitForTimeout(step.delayTime);
          const screenshotUrlAfterDelay = await captureAndStoreScreenshot(
            page,
            testId,
            step.id
          );
          logs.push({ message: "Wait completed", status: "success" });
          screenShots.push(screenshotUrlBeforeDelay);
          screenShots.push(screenshotUrlAfterDelay);
          break;

        case "Import Reusable Test":
          if (!isReusable) {
            // Execute the imported test independently without mutating the main steps
            await executeImportedTest(
              page,
              step.importedTestId,
              testId,
              logs,
              stepResults
            );
          } else {
            logs.push({
              message: `Skipping nested import of reusable test to prevent recursion`,
              status: "warning",
            });
          }
          break;

        default:
          logs.push({
            message: `Unknown action type: ${step.actionType}`,
            status: "error",
          });
          throw new Error(`Unknown action type: ${step.actionType}`);
      }
    } catch (error) {
      logs.push({
        message: `Error in step ${index + 1}: ${error.message}`,
        status: "error",
      });
      throw error;
    }

    await page.waitForTimeout(1000);
  }

  return clonedSteps;
}

// Updated getSelector function with token tracking


// Main entry point for running a test scenario
export default async function RunScenario(req, res) {
  let browser;
  let logs = [];
  let screenShots = [];

  try {
    let { startUrl, name, steps, testId } = req.body;

    logs.push({ message: `Starting scenario: ${name}`, status: "info" });

    if (!startUrl || !steps || !name) {
      logs.push({
        message: "Error: Missing required parameters",
        status: "error",
      });
      return res.status(404).json({
        status: "error",
        message: "Something is missing",
        logs,
        screenShots,
      });
    }

    console.log("Starting browser...........");
    browser = await chromium.launch({ headless: true, slowMo: 50 });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(startUrl, { timeout: 900000 });
      logs.push({ message: `Navigated to ${startUrl}`, status: "success" });

      console.log(
        `starting execution for test ${testId}, name ${name},steps:`,
        steps
      );

      // Execute the steps and pass the cloned steps to avoid any mutation
      const executedSteps = await executeSteps(
        page,
        steps,
        testId,
        startUrl,
        name,
        logs,
        screenShots
      );

      // Get token usage and cost
      const tokenUsage = tokenTracker.getUsage();
      console.log(tokenUsage);
      
      return res.status(200).json({
        status: "success",
        screenShots,
        logs,
        steps: executedSteps,
        tokenUsage: {
          totalTokens: tokenUsage.totalTokens,
          promptTokens: tokenUsage.promptTokens,
          completionTokens: tokenUsage.completionTokens,
          estimatedCost: tokenUsage.cost,
          modelUsed: tokenUsage.model
        }
      });
    } catch (error) {
      logs.push({
        message: `Error during test execution: ${error.message}`,
        status: "error",
      });
      return res.status(500).json({
        status: "error",
        message: `Error during test execution: ${error.message}`,
        logs,
        screenShots,
      });
    } finally {
      if (page) await page.close();
      if (context) await context.close();
      if (browser) await browser.close();
    }
  } catch (error) {
    logs.push({
      message: `Fatal error in run scenario: ${error.message}`,
      status: "error",
    });
    return res.status(500).json({
      status: "error",
      message: `Something went wrong in run scenario: ${error.message}`,
      screenShots,
      logs,
    });
  }
}

// Retry logic if an action fails
async function performWithRetry(
  action,
  retries,
  step,
  name,
  type,
  screenshot,
  err
) {
  let errmsg = "";

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await action(step.selector);
      return step; // If action succeeds, return the updated step
    } catch (error) {
      console.error(
        `Error during ${type} attempt ${attempt} for step ${step.selector}: ${error.message}`
      );
      if (attempt < retries) {
        console.log(`Retrying to fetch selector for step ${step.selector}...`);
        try {
          const selectorObject = await getSelector(
            step,
            name,
            screenshot,
            errmsg
          );
          step.selector = selectorObject.selector;
        } catch (errormsg) {
          errmsg = errormsg;
          console.error(`Failed to re-fetch selector`, errormsg);
        }
      } else {
        throw new Error(
          `Failed to execute ${type} for step ${step.selector} after ${retries} attempts: ${error.message}`
        );
      }
    }
  }

  return step;
}
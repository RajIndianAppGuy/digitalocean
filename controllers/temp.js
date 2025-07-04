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
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

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
  stepResults,
  addLog
) {
  console.log(`Starting imported test execution ${testId},`);
  const importedTest = await fetchTest(importedTestId);
  if (importedTest) {
    addLog(`Executing imported test: ${importedTest.name}`, "info");

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
      true,
      addLog
    );

    addLog(`Completed imported test: ${importedTest.name}`, "success");
  } else {
    addLog(`Failed to import test: ${importedTestId}`, "error");
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
  isReusable = false,
  addLog
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
        addLog(`Error in updating step: ${error.message}`, "error");
        throw new Error(`Error in updating step: ${error.message}`);
      }
    } else {
      count++;
    }

    try {
      switch (step.actionType) {
        case "Click Element":
          addLog(`Clicking on element: "${step.details.element}"`, "info");
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
          
          // Use performWithRetry for click action
          await performWithRetry(
            page,
            async (selector) => await page.locator(selector).click(),
            3,
            step,
            name,
            'click',
            screenshotUrlBeforeClick,
            ''
          );

          await page.waitForTimeout(4000);

          const screenshotUrlAfterClick = await captureAndStoreScreenshot(
            page,
            testId,
            step.id
          );

          screenShots.push(screenshotUrlAfterClick);

          addLog(`Element "${step.details.element}" clicked successfully`, "success");
          break;

        case "Fill Input":
          addLog(`Filling input: "${step.details.description}" with value: "${step.details.value}"`, "info");

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

          // Use performWithRetry for fill action
          await performWithRetry(
            page,
            async (selector) => await page.locator(selector).fill(step.details.value),
            3,
            step,
            name,
            'fill',
            screenshotUrlbeforeInput,
            ''
          );

          const screenshotUrlAfterInput = await captureAndStoreScreenshot(
            page,
            testId,
            step.id
          );

          screenShots.push(screenshotUrlAfterInput);
          addLog(`Input "${step.details.description}" filled successfully`, "success");
          break;

        case "AI Visual Assertion":
          addLog(`Performing AI Visual Assertion: "${step.question}"`, "info");
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

          addLog(`${analysisResult}`, "info");
          break;

        case "Delay":
          addLog(`Waiting for ${step.delayTime} milliseconds`, "info");
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
          addLog("Wait completed", "success");
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
              steps,
              addLog
            );
          } else {
            addLog(`Skipping nested import of reusable test to prevent recursion`, "warning");
          }
          break;

        default:
          addLog(`Unknown action type: ${step.actionType}`, "error");
          throw new Error(`Unknown action type: ${step.actionType}`);
      }
    } catch (error) {
      addLog(`Error in step ${index + 1}: ${error.message}`, "error");
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
    let { startUrl, name, steps, testId, email } = req.body;

    const addLog = (message, status) => {
      logs.push({
        message,
        status,
        timestamp: new Date().toLocaleString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: true
        })
      });
    };

    addLog(`Starting scenario: ${name}`, "info");

    if (!startUrl || !steps || !name) {
      addLog("Error: Missing required parameters", "error");
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

    if(email == "raj@indianappguy.com"){
      email = "rajdama1729@gmail.com"
    }

    try {
      await page.goto(startUrl, { timeout: 900000 });
      addLog(`Navigated to ${startUrl}`, "success");

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
        screenShots,
        false,
        addLog
      );

      // Get token usage and cost
      const tokenUsage = tokenTracker.getUsage();
      console.log(tokenUsage);

      // Create a more attractive email template
      const getStatusColor = (status) => {
        switch(status) {
          case 'success': return '#4CAF50';
          case 'error': return '#f44336';
          case 'warning': return '#ff9800';
          case 'info': return '#2196F3';
          default: return '#757575';
        }
      };

      const getStatusIcon = (status) => {
        switch(status) {
          case 'success': return '✅';
          case 'error': return '❌';
          case 'warning': return '⚠️';
          case 'info': return 'ℹ️';
          default: return '•';
        }
      };

      const formatTimestamp = () => {
        const now = new Date();
        return now.toLocaleString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: true
        });
      };

      const emailTemplate = `
        <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background-color: #f9f9f9;">
          <div style="background-color: #2196F3; color: white; padding: 20px; border-radius: 5px 5px 0 0;">
            <h1 style="margin: 0;">Test Execution Report</h1>
            <p style="margin: 5px 0 0 0;">${name}</p>
          </div>
          
          <div style="background-color: white; padding: 20px; border-radius: 0 0 5px 5px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            <div style="margin-bottom: 20px;">
              <h2 style="color: #333; margin-bottom: 10px;">Execution Summary</h2>
              <p style="margin: 5px 0;"><strong>Test ID:</strong> ${testId}</p>
              <p style="margin: 5px 0;"><strong>Start URL:</strong> ${startUrl}</p>
              <p style="margin: 5px 0;"><strong>Execution Time:</strong> ${logs[0].timestamp}</p>
            </div>

            <div style="margin-bottom: 20px;">
              <h2 style="color: #333; margin-bottom: 10px;">Token Usage</h2>
              <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px;">
                <p style="margin: 5px 0;"><strong>Total Tokens:</strong> ${tokenUsage.totalTokens}</p>
                <p style="margin: 5px 0;"><strong>Estimated Cost:</strong> $${tokenUsage.cost}</p>
                <p style="margin: 5px 0;"><strong>Model Used:</strong> ${tokenUsage.model}</p>
              </div>
            </div>

            <div>
              <h2 style="color: #333; margin-bottom: 10px;">Execution Logs</h2>
              ${logs.map(log => `
                <div style="margin: 10px 0; padding: 10px; border-left: 4px solid ${getStatusColor(log.status)}; background-color: #f8f9fa;">
                  <div style="display: flex; align-items: center;">
                    <span style="margin-right: 10px;">${getStatusIcon(log.status)}</span>
                    <span style="color: ${getStatusColor(log.status)}; font-weight: bold;">${log.status.toUpperCase()}</span>
                    <span style="margin-left: auto; color: #666; font-size: 0.9em;">${log.timestamp}</span>
                  </div>
                  <p style="margin: 5px 0 0 0; color: #333;">${log.message}</p>
                </div>
              `).join('')}
            </div>
          </div>

          <div style="text-align: center; margin-top: 20px; color: #666; font-size: 0.9em;">
            <p>This is an automated report generated by MagicSlides Test Runner</p>
          </div>
        </div>
      `;

      const data = await resend.emails.send({
        from: "support@magicslides.io",
        to: email,
        subject: `Test Execution Report: ${name}`,
        html: emailTemplate
      });
      console.log("=======================>",data);
      
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
      addLog(`Error during test execution: ${error.message}`, "error");
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
    addLog(`Fatal error in run scenario: ${error.message}`, "error");
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
  page,
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
      // Modified to handle multiple elements by selecting the visible one
      const elements = await page.locator(step.selector).all();
      if (elements.length > 1) {
        console.log(`Found ${elements.length} matching elements, checking visibility...`);
        // Find the first visible element
        let visibleElement = null;
        for (const element of elements) {
          const isVisible = await element.isVisible();
          if (isVisible) {
            visibleElement = element;
            break;
          }
        }
        
        if (visibleElement) {
          console.log('Clicking visible element');
          await visibleElement.click();
        } else {
          // If no visible element found, try to make the element visible
          console.log('No visible element found, attempting to make element visible');
          await page.evaluate((selector) => {
            const elements = document.querySelectorAll(selector);
            for (const element of elements) {
              element.style.display = 'block';
              element.style.visibility = 'visible';
              element.style.opacity = '1';
            }
          }, step.selector);
          // Try clicking the first element after making it visible
          await elements[0].click();
        }
      } else {
        await action(step.selector);
      }
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
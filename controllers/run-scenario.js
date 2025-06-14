import axios from "axios";
import { chromium } from "playwright";
import { analyzeScreenshot } from "../config/vision-api.js";
import {
  getFullyRenderedContent,
  getSelector,
  highlightElement,
} from "../utils/helper.js";
import { updateTest, fetchTest, createStreamRun, updateStreamRun } from "../supabase/tables.js";
import TokenTracker from "../utils/tokenTracker.js";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

// Utility functions for email templates
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

// Deep clone utility function to prevent modifying original arrays
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// Capture and store a screenshot
async function captureAndStoreScreenshot(page, testId, stepId, runId) {
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
    },{
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    console.log("Screenshot Captured");
    
    // Update screenshot in Supabase
    await updateStreamRun(runId, { screenshot: response.data.screenshotUrl });
    
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
  addLog,
  tokenTracker,
  runId
) {
  console.log(`Starting imported test execution ${testId},`);
  const importedTest = await fetchTest(importedTestId);
  if (importedTest) {
    addLog(`Executing imported test: ${importedTest.name}`, "info");

    const importedTestScreenshots = [];

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
      importedTestScreenshots,
      true,
      addLog,
      tokenTracker,
      runId
    );

    addLog(`Completed imported test: ${importedTest.name}`, "success");

    return {
      screenshots: importedTestScreenshots,
      steps: clonedImportedSteps
    };
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
  addLog,
  tokenTracker,
  runId
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
        addLog(`Reading page`, "info");
        const res1 = await axios.post(
          `${process.env.DOMAIN_NAME}/embbeding`,
          { content, url: currentUrl },
          { maxContentLength: Infinity, maxBodyLength: Infinity }
        );

        addLog(`Reading page`, "success");

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
            step.id,
            runId
          );
          if (!step.cache) {
            const initialClickSelector = await getSelector(
              step,
              name,
              clickImage,
              '',
              tokenTracker
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
            step.id,
            runId
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
            '',
            tokenTracker,
            screenShots,
            testId,
            clonedSteps,
            runId
          );

          await page.waitForTimeout(4000);

          const screenshotUrlAfterClick = await captureAndStoreScreenshot(
            page,
            testId,
            step.id,
            runId
          );

          screenShots.push(screenshotUrlAfterClick);

          addLog(`Element "${step.details.element}" clicked successfully`, "success");
          break;

        case "Fill Input":
          addLog(`Filling input: "${step.details.description}" with value: "${step.details.value}"`, "info");

          const inputImage = await captureAndStoreScreenshot(
            page,
            testId,
            step.id,
            runId
          );
          if (!step.cache) {
            const initialFillSelector = await getSelector(
              step,
              name,
              inputImage,
              '',
              tokenTracker
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
            step.id,
            runId
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
            '',
            tokenTracker,
            screenShots,
            testId,
            clonedSteps,
            runId
          );

          const screenshotUrlAfterInput = await captureAndStoreScreenshot(
            page,
            testId,
            step.id,
            runId
          );

          screenShots.push(screenshotUrlAfterInput);
          addLog(`Input "${step.details.description}" filled successfully`, "success");
          break;

        case "AI Visual Assertion":
          addLog(`Performing AI Visual Assertion: "${step.question}"`, "info");
          const screenshotUrl = await captureAndStoreScreenshot(
            page,
            testId,
            step.id,
            runId
          );
          const analysisResult = await analyzeScreenshot(
            screenshotUrl,
            step.question,
            tokenTracker
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
            step.id,
            runId
          );
          await page.waitForTimeout(step.delayTime);
          const screenshotUrlAfterDelay = await captureAndStoreScreenshot(
            page,
            testId,
            step.id,
            runId
          );
          addLog("Wait completed", "success");
          screenShots.push(screenshotUrlBeforeDelay);
          screenShots.push(screenshotUrlAfterDelay);
          break;

        case "Import Reusable Test":
          if (!isReusable) {
            // Execute the imported test independently without mutating the main steps
            const importResult = await executeImportedTest(
              page,
              step.importedTestId,
              testId,
              logs,
              addLog,
              tokenTracker,
              runId
            );

            screenShots.push(...importResult.screenshots);
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
  const tokenTracker = new TokenTracker();
  let executionTimeout;
  let runId; // Declare runId at the top level
  let testInfo = {
    name: 'Unknown Test',
    testId: 'Unknown',
    startUrl: 'Unknown',
    email: 'Unknown'
  };

  // Define addLog function at the top level
  let addLog;
  const initializeAddLog = (runId) => {
    addLog = async (message, status) => {
      const logEntry = {
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
      };
      
      logs.push(logEntry);
      
      // Update logs in Supabase
      await updateStreamRun(runId, { logs: [logEntry] });
    };
  };

  // Function to send error email
  const sendErrorEmail = async (error, testInfo, logs) => {
    // Format error message to be more user-friendly
    const formatErrorMessage = (error) => {
      if (!error.message) return 'An unknown error occurred';
      
      // Handle Playwright timeout errors
      if (error.message.includes('Timeout') && error.message.includes('exceeded')) {
        const actionMatch = error.message.match(/Failed to execute (\w+) for step (.*?) after/);
        if (actionMatch) {
          const [_, action, step] = actionMatch;
          return `The test couldn't ${action} on "${step}" because the element wasn't ready in time. This usually means the element was either not visible, disabled, or the page was still loading.`;
        }
      }
      
      // Handle element not found errors
      if (error.message.includes('No elements found matching selector')) {
        const selectorMatch = error.message.match(/selector: (.*?)$/);
        if (selectorMatch) {
          return `The test couldn't find the element "${selectorMatch[1]}" on the page. This could mean the element was removed or the page structure changed.`;
        }
      }
      
      // Handle element not enabled errors
      if (error.message.includes('element is not enabled')) {
        return 'The test tried to interact with an element that was disabled or not ready for interaction. This could be because the element was not fully loaded or was temporarily disabled.';
      }
      
      // For other errors, return a simplified version
      return error.message.split('\n')[0]; // Take just the first line of the error
    };

    const errorEmailTemplate = `
      <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background-color: #f9f9f9;">
        <div style="background-color: #f44336; color: white; padding: 20px; border-radius: 5px 5px 0 0;">
          <h1 style="margin: 0;">Test Execution Failed</h1>
          <p style="margin: 5px 0 0 0;">${testInfo.name}</p>
        </div>
        
        <div style="background-color: white; padding: 20px; border-radius: 0 0 5px 5px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <div style="margin-bottom: 20px;">
            <h2 style="color: #333; margin-bottom: 10px;">Error Details</h2>
            <div style="background-color: #ffebee; padding: 15px; border-radius: 5px; border-left: 4px solid #f44336;">
              <p style="margin: 5px 0; color: #d32f2f;"><strong>Error Message:</strong> ${formatErrorMessage(error)}</p>
              <p style="margin: 5px 0;"><strong>Test ID:</strong> ${testInfo.testId}</p>
              <p style="margin: 5px 0;"><strong>Start URL:</strong> ${testInfo.startUrl}</p>
              <p style="margin: 5px 0;"><strong>Failure Time:</strong> ${new Date().toLocaleString()}</p>
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
          <p>This is an automated error report generated by MagicSlides Test Runner</p>
        </div>
      </div>
    `;

    try {
      await resend.emails.send({
        from: "support@magicslides.io",
        to: testInfo.email,
        subject: `Test Execution Failed: ${testInfo.name}`,
        html: errorEmailTemplate
      });
    } catch (emailError) {
      console.error('Failed to send error email:', emailError);
    }
  };

  try {
    let { startUrl, name, steps, testId, email, runId: requestRunId } = req.body;
    runId = requestRunId; // Assign the runId from request to our top-level variable
    
    // Update testInfo with actual values
    testInfo = {
      name: name || 'Unknown Test',
      testId: testId || 'Unknown',
      startUrl: startUrl || 'Unknown',
      email: email || 'Unknown'
    };

    // Set a timeout for the entire execution (30 minutes)
    executionTimeout = setTimeout(() => {
      throw new Error('Test execution timed out after 30 minutes');
    }, 30 * 60 * 1000);

    // Initialize stream run in Supabase
    await createStreamRun(runId);

    // Initialize addLog with runId
    initializeAddLog(runId);

    addLog(`Starting scenario: ${testInfo.name}`, "info");

    if (!startUrl || !steps || !name) {
      const error = new Error("Missing required parameters");
      try {
        await sendErrorEmail(error, testInfo, logs);
        await addLog("Error: Missing required parameters", "error");
      } catch (logError) {
        console.error('Error in error handling:', logError);
      }
      return res.status(404).json({
        status: "error",
        message: "Something is missing",
        logs,
        screenShots,
        runId
      });
    }

    console.log("Starting browser...........");
    browser = await chromium.launch({ 
      headless: true, 
      slowMo: 50,
      timeout: 30000 // 30 second timeout for browser launch
    });
    const context = await browser.newContext();
    const page = await context.newPage();

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
        addLog,
        tokenTracker,
        runId
      );

      // Get token usage and cost
      const tokenUsage = tokenTracker.getUsage();
      console.log(tokenUsage);

      // Create a more attractive email template
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
      
      // Update final state in Supabase
      await updateStreamRun(runId, { 
        logs: logs,
        screenshot: screenShots[screenShots.length - 1] || null
      });
      
      return res.status(200).json({
        status: "success",
        screenShots,
        logs,
        steps: executedSteps,
        runId,
        tokenUsage: {
          totalTokens: tokenUsage.totalTokens,
          promptTokens: tokenUsage.promptTokens,
          completionTokens: tokenUsage.completionTokens,
          estimatedCost: tokenUsage.cost,
          modelUsed: tokenUsage.model
        }
      });
    } catch (error) {
      // Capture final error screenshot
      try {
        const finalErrorScreenshot = await captureAndStoreScreenshot(
          page,
          testId,
          null, // Use null for stepId to avoid DB type errors
          runId
        );
        screenShots.push(finalErrorScreenshot);
      } catch (screenshotError) {
        console.error('Failed to capture final error screenshot:', screenshotError);
      }

      try {
        await sendErrorEmail(error, testInfo, logs);
        await addLog(`Error during test execution: ${error.message}`, "error");
        
        // Update the final state in Supabase before sending response
        await updateStreamRun(runId, { 
          logs: logs,
          screenshot: screenShots[screenShots.length - 1] || null
        });
      } catch (logError) {
        console.error('Error in error handling:', logError);
      }
      
      return res.status(500).json({
        status: "error",
        message: `Error during test execution: ${error.message}`,
        logs,
        screenShots,
        runId
      });
    } finally {
      clearTimeout(executionTimeout);
      if (page) await page.close().catch(console.error);
      if (context) await context.close().catch(console.error);
      if (browser) await browser.close().catch(console.error);
    }
  } catch (error) {
    try {
      await sendErrorEmail(error, testInfo, logs);
      await addLog(`Fatal error in run scenario: ${error.message}`, "error");
      
      // Update the final state in Supabase before sending response
      await updateStreamRun(runId, { 
        logs: logs,
        screenshot: screenShots[screenShots.length - 1] || null
      });
    } catch (logError) {
      console.error('Error in error handling:', logError);
    }
    
    return res.status(500).json({
      status: "error",
      message: `Something went wrong in run scenario: ${error.message}`,
      screenShots,
      logs,
      runId
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
  err,
  tokenTracker,
  screenShots,
  testId,
  clonedSteps,
  runId
) {
  let errmsg = "";
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Validate selector before proceeding
      if (!step.selector || step.selector.trim() === '') {
        console.log('Empty selector detected, fetching new selector...');
        const selectorObject = await getSelector(
          step,
          name,
          screenshot,
          errmsg,
          tokenTracker
        );
        step.selector = selectorObject.selector;
        step.cache = false;
      }

      // Capture screenshot before action
      const screenshotBeforeAction = await captureAndStoreScreenshot(
        page,
        testId,
        step.id,
        runId
      );
      screenShots.push(screenshotBeforeAction);

      // Highlight the element before performing action
      await highlightElement(page, step.selector);

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
      } else if (elements.length === 0) {
        throw new Error(`No elements found matching selector: ${step.selector}`);
      } else {
        await action(step.selector);
      }

      // Capture screenshot after action
      const screenshotAfterAction = await captureAndStoreScreenshot(
        page,
        testId,
        step.id,
        runId
      );
      screenShots.push(screenshotAfterAction);

      // Update cache after successful action
      step.cache = true;
      
      // Update the cache in the main steps array
      const stepIndex = clonedSteps.findIndex(s => s.id === step.id);
      if (stepIndex !== -1) {
        clonedSteps[stepIndex].cache = true;
        clonedSteps[stepIndex].selector = step.selector;
        // Update the test in the database with the new cache status
        await updateTest(testId, clonedSteps);
      }
      
      // Wait for a short time to ensure the action is complete
      await page.waitForTimeout(1000);

      return step; // If action succeeds, return the updated step
    } catch (error) {
      lastError = error;
      console.error(
        `Error during ${type} attempt ${attempt} for step ${step.selector}: ${error.message}`
      );

      // Capture error screenshot
      try {
        const errorScreenshot = await captureAndStoreScreenshot(
          page,
          testId,
          step.id,
          runId
        );
        screenShots.push(errorScreenshot);
      } catch (screenshotError) {
        console.error('Failed to capture error screenshot:', screenshotError);
      }

      if (attempt < retries) {
        console.log(`Retrying to fetch selector for step ${step.selector}...`);
        try {
          const selectorObject = await getSelector(
            step,
            name,
            screenshot,
            errmsg,
            tokenTracker
          );
          if (!selectorObject || !selectorObject.selector) {
            throw new Error('Failed to get valid selector from getSelector');
          }
          step.selector = selectorObject.selector;
          // Reset cache when retrying with new selector
          step.cache = false;
          
          // Update the cache in the main steps array
          const stepIndex = clonedSteps.findIndex(s => s.id === step.id);
          if (stepIndex !== -1) {
            clonedSteps[stepIndex].cache = false;
            clonedSteps[stepIndex].selector = step.selector;
          }
        } catch (errormsg) {
          errmsg = errormsg;
          console.error(`Failed to re-fetch selector`, errormsg);
          throw new Error(`Failed to get valid selector after ${attempt} attempts: ${errormsg.message}`);
        }
      } else {
        // On final attempt, throw the last error with all context
        throw new Error(
          `Failed to execute ${type} for step ${step.selector} after ${retries} attempts: ${lastError.message}`
        );
      }
    }
  }

  return step;
}

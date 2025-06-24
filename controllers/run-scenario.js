import axios from "axios";
import { Stagehand } from "@browserbasehq/stagehand";
import { analyzeScreenshot } from "../config/vision-api.js";
import {
  getSelector,
  getUserFriendlyErrorMessage,
  highlightElement,
} from "../utils/helper.js";
import {
  updateTest,
  fetchTest,
  createStreamRun,
  updateStreamRun,
  uploadFileToSupabase,
  downloadFileFromSupabase,
} from "../supabase/tables.js";
import TokenTracker from "../utils/tokenTracker.js";
import { Resend } from "resend";
import { supabase } from "../utils/SupabaseClient.js";
import fs from "fs";

const resend = new Resend(process.env.RESEND_API_KEY);

// Utility functions for email templates
const getStatusColor = (status) => {
  switch (status) {
    case "success":
      return "#4CAF50";
    case "error":
      return "#f44336";
    case "warning":
      return "#ff9800";
    case "info":
      return "#2196F3";
    default:
      return "#757575";
  }
};

const getStatusIcon = (status) => {
  switch (status) {
    case "success":
      return "✅";
    case "error":
      return "❌";
    case "warning":
      return "⚠️";
    case "info":
      return "ℹ️";
    default:
      return "•";
  }
};

// Deep clone utility function to prevent modifying original arrays
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// Helper to push screenshots only if not duplicate of last
function pushUniqueScreenshot(screenShots, url) {
  if (!url) return;
  if (screenShots.length === 0 || screenShots[screenShots.length - 1] !== url) {
    screenShots.push(url);
  }
}

// Capture and store a screenshot directly to Supabase
async function captureAndStoreScreenshot(
  page,
  testId,
  stepId,
  runId,
  fullPage = false
) {
  try {
    const screenshotBuffer = await page.screenshot({
      fullPage,
      timeout: 300000,
    });

    // Generate a unique filename
    const fileName = `${testId}_step${stepId || "final"}_${Date.now()}.png`;

    // Upload to Supabase storage
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from("screenshots")
      .upload(fileName, screenshotBuffer, {
        contentType: "image/png",
      });

    if (uploadError) throw uploadError;

    // Get public URL
    const { data: urlData } = supabase.storage
      .from("screenshots")
      .getPublicUrl(fileName);

    if (!urlData) throw new Error("Failed to get public URL");

    const publicUrl = urlData.publicUrl;

    console.log("Screenshot Captured and stored:", publicUrl);

    // Update screenshot in Supabase
    await updateStreamRun(runId, { screenshot: publicUrl });

    return publicUrl;
  } catch (error) {
    console.error(
      `Error capturing/storing screenshot for step ${stepId}:`,
      error
    );
    throw error;
  }
}

// Helper: Scroll and try image-only selector generation at each scroll position
async function findSelectorByScrolling(
  page,
  step,
  name,
  tokenTracker,
  stepInfo,
  testId,
  runId
) {
  const scrollStep = 500; // px
  let lastScrollTop = -1;
  let scrollAttempts = 0;
  const maxScrolls = 20; // Prevent infinite loops

  while (scrollAttempts < maxScrolls) {
    // Take screenshot at current scroll position
    const screenshotUrl = await captureAndStoreScreenshot(
      page,
      testId,
      step.id,
      runId,
      false
    );
    // Try image-only selector
    try {
      const result = await getSelector(
        page,
        step,
        name,
        screenshotUrl,
        "",
        tokenTracker,
        stepInfo,
        false // isRetryDueToFailedSelector
      );
      if (result && result.selector) {
        return result; // Found!
      }
    } catch (e) {
      // If fails, continue
    }
    // Scroll down
    const scrollTop = await page.evaluate((scrollStep) => {
      window.scrollBy(0, scrollStep);
      return window.scrollY;
    }, scrollStep);
    // If we can't scroll further, break
    if (scrollTop === lastScrollTop) break;
    lastScrollTop = scrollTop;
    scrollAttempts++;
  }
  // Fallback to Stagehand/embedding
  return await getSelector(
    page,
    step,
    name,
    null, // No screenshot for fallback
    "",
    tokenTracker,
    stepInfo,
    true // isRetryDueToFailedSelector = true (triggers Stagehand/embedding)
  );
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
      steps: clonedImportedSteps,
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
    // if (page.url().includes("google")) {
    //   // Email input
    //   await page.fill('input[type="email"]', "raj@indianappguy.com");
    //   await page.click('button:has-text("Next")');

    //   // Wait for password field and fill
    //   await page.waitForSelector('input[type="password"]', { timeout: 5000 });
    //   await page.fill('input[type="password"]', "Rajdama@1234");
    //   await page.click('button:has-text("Next")');

    //   if (!page.url().includes("magicslides.app")) {
    //     await page.goto("https://www.magicslides.app/", {
    //       timeout: 60000,
    //       waitUntil: "networkidle",
    //     });
    //   }
    // }

    // Update current URL and add it to step for potential fallback embedding approach
    if (page.url() !== currentUrl) {
      currentUrl = page.url();
    }
    step.currentUrl = currentUrl; // Add current URL to step for fallback embedding approach

    // Initialize imageOnlyAttempted flag if not already set
    if (step.imageOnlyAttempted === undefined) {
      step.imageOnlyAttempted = false;
      console.log(
        `Initialized imageOnlyAttempted to false for step ${step.id}`
      );
    }

    try {
      switch (step.actionType) {
        case "Click Element":
          addLog(`Clicking on element: "${step.details.element}"`, "info");
          if (!step.cache) {
            // Ensure current URL is set in step for potential fallback embedding approach
            step.currentUrl = page.url();
            console.log(
              `Initial getSelector call - step.imageOnlyAttempted: ${step.imageOnlyAttempted}`
            );
            // Use scroll-and-screenshot approach
            const initialClickSelector = await findSelectorByScrolling(
              page,
              step,
              name,
              tokenTracker,
              { type: "Click Element", description: step.details.element },
              testId,
              runId
            );
            step.selector = initialClickSelector.selector;
            // Update the cloned steps and avoid mutating the original steps array
            console.log(
              `Updating testid ${testId} with cloned steps:`,
              clonedSteps
            );
            await updateTest(testId, clonedSteps); // Update with cloned steps
          }
          await highlightElement(page, step.selector);
          // Use performWithRetry for click action
          await performWithRetry(
            page,
            async (selector) => await page.locator(selector).click(),
            3,
            step,
            name,
            "click",
            null, // screenshotUrlBeforeClick not needed here
            "",
            tokenTracker,
            screenShots,
            testId,
            clonedSteps,
            runId
          );
          await page.waitForTimeout(4000);
          addLog(
            `Element "${step.details.element}" clicked successfully`,
            "success"
          );
          break;

        case "Fill Input":
          addLog(
            `Filling input: "${step.details.description}" with value: "${step.details.value}"`,
            "info"
          );
          if (!step.cache) {
            // Ensure current URL is set in step for potential fallback embedding approach
            step.currentUrl = page.url();
            console.log(
              `Initial getSelector call (Fill Input) - step.imageOnlyAttempted: ${step.imageOnlyAttempted}`
            );
            // Use scroll-and-screenshot approach
            const initialFillSelector = await findSelectorByScrolling(
              page,
              step,
              name,
              tokenTracker,
              { type: "Fill Input", description: step.details.description },
              testId,
              runId
            );
            step.selector = initialFillSelector.selector;
            // Update the cloned steps
            console.log(
              `Updating testid ${testId} with cloned steps:`,
              clonedSteps
            );
            await updateTest(testId, clonedSteps); // Update with cloned steps
          }
          await highlightElement(page, step.selector);
          // Use performWithRetry for fill action
          await performWithRetry(
            page,
            async (selector) =>
              await page.locator(selector).fill(step.details.value),
            3,
            step,
            name,
            "fill",
            null, // screenshotUrlbeforeInput not needed here
            "",
            tokenTracker,
            screenShots,
            testId,
            clonedSteps,
            runId
          );
          addLog(
            `Input "${step.details.description}" filled successfully`,
            "success"
          );
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
            tokenTracker,
            { type: "AI Visual Assertion", description: step.question }
          );
          console.log(analysisResult);
          pushUniqueScreenshot(screenShots, screenshotUrl);

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
          pushUniqueScreenshot(screenShots, screenshotUrlBeforeDelay);
          pushUniqueScreenshot(screenShots, screenshotUrlAfterDelay);
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

            for (const s of importResult.screenshots) {
              pushUniqueScreenshot(screenShots, s);
            }
          } else {
            addLog(
              `Skipping nested import of reusable test to prevent recursion`,
              "warning"
            );
          }
          break;

        case "Upload File": {
          addLog(
            `Processing file upload step: ${step.details.description}`,
            "info"
          );
          // Screenshot before upload
          const screenshotUrlBeforeUpload = await captureAndStoreScreenshot(
            page,
            testId,
            step.id,
            runId
          );
          pushUniqueScreenshot(screenShots, screenshotUrlBeforeUpload);
          if (!step.cache) {
            const [actionPreview] = await page.observe(
              step.details.description
            );
            await page.act(actionPreview);
            step.selector = actionPreview;
            step.cache = true;
            const stepIndex = clonedSteps.findIndex((s) => s.id === step.id);
            if (stepIndex !== -1) {
              clonedSteps[stepIndex].cache = true;
              clonedSteps[stepIndex].selector = actionPreview;
              await updateTest(testId, clonedSteps);
            }
          } else {
            await page.act(step.selector);
          }
          let fileName = step.details.file_content;
          let localPath = null;
          if (fileName && typeof fileName === "string") {
            // file_content is just the file name, download from Supabase
            localPath = await downloadFileFromSupabase(fileName);
            const fileInput = await page.locator('input[type="file"]');
            await fileInput.setInputFiles(localPath); // Ensure upload is complete
            // Screenshot after upload
            const screenshotUrlAfterUpload = await captureAndStoreScreenshot(
              page,
              testId,
              step.id,
              runId
            );
            pushUniqueScreenshot(screenShots, screenshotUrlAfterUpload);
            // Wait a moment to ensure file is not locked
            await page.waitForTimeout(1000);
            // Add logging before deletion
            console.log("Attempting to delete file:", localPath);
            try {
              fs.unlinkSync(localPath);
              console.log("File deleted successfully:", localPath);
              addLog(`File deleted successfully: ${localPath}`, "success");
            } catch (err) {
              console.error(
                `Failed to delete local file after upload: ${localPath}`,
                err
              );
              addLog(
                `Failed to delete local file after upload: ${localPath} - ${err.message}`,
                "error"
              );
            }
            addLog(`File upload complete`, "success");
          } else {
            addLog(`No valid file name provided for upload step`, "error");
            throw new Error("No valid file name provided for upload step");
          }
          break;
        }

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
    name: "Unknown Test",
    testId: "Unknown",
    startUrl: "Unknown",
    email: "Unknown",
  };

  // Define addLog function at the top level
  let addLog;
  const initializeAddLog = (runId) => {
    addLog = async (message, status) => {
      const logEntry = {
        message,
        status,
        timestamp: new Date().toLocaleString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: true,
        }),
      };

      logs.push(logEntry);

      // Update logs in Supabase
      await updateStreamRun(runId, { logs: [logEntry] });
    };
  };

  // Function to send error email
  const sendErrorEmail = async (error, testInfo, logs, screenShots) => {
    const rawMessage = error?.message || "Unknown error occurred";

    // Get explanation via OpenAI
    let userFriendlyMessage = "Something went wrong during the test.";
    try {
      userFriendlyMessage = await getUserFriendlyErrorMessage(
        rawMessage,
        tokenTracker
      );
    } catch (openAiError) {
      console.error("OpenAI error explanation failed:", openAiError);
    }

    const errorEmailTemplate = `
      <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background-color: #f9f9f9;">
        <div style="background-color: #f44336; color: white; padding: 20px; border-radius: 5px 5px 0 0;">
          <h1 style="margin: 0;">Test Execution Failed</h1>
          <p style="margin: 5px 0 0 0;">${testInfo.name}</p>
        </div>
        
        <div style="background-color: white; padding: 20px; border-radius: 0 0 5px 5px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <h2 style="color: #333;">Reason</h2>
          <p style="margin: 10px 0; font-size: 1em; color: #333;">${userFriendlyMessage}</p>
          
          <h2 style="color: #333; margin-top: 20px;">Raw Error Details</h2>
          <div style="background-color: #ffebee; padding: 15px; border-radius: 5px; border-left: 4px solid #f44336;">
            <p style="margin: 5px 0; color: #d32f2f;"><strong>Raw Error:</strong> ${rawMessage}</p>
            <p style="margin: 5px 0;"><strong>Test ID:</strong> ${testInfo.testId}</p>
            <p style="margin: 5px 0;"><strong>Start URL:</strong> ${testInfo.startUrl}</p>
            <p style="margin: 5px 0;"><strong>Failure Time:</strong> ${new Date().toLocaleString()}</p>
          </div>

          ${
            screenShots && screenShots.length > 0
              ? `
            <div style="margin-bottom: 20px;">
              <h2 style="color: #333; margin-bottom: 10px;">Last Screenshot Before Error</h2>
              <img src="${screenShots[screenShots.length - 1]}" alt="Last Screenshot" style="max-width: 100%; border-radius: 5px; border: 1px solid #ccc;" />
            </div>
          `
              : ""
          }

          <h2 style="color: #333; margin-top: 20px;">Execution Logs</h2>
          ${logs
            .map(
              (log) => `
            <div style="margin: 10px 0; padding: 10px; border-left: 4px solid ${getStatusColor(log.status)}; background-color: #f8f9fa;">
              <div style="display: flex; align-items: center;">
                <span style="margin-right: 10px;">${getStatusIcon(log.status)}</span>
                <span style="color: ${getStatusColor(log.status)}; font-weight: bold;">${log.status.toUpperCase()}</span>
                <span style="margin-left: auto; color: #666; font-size: 0.9em;">${log.timestamp}</span>
              </div>
              <p style="margin: 5px 0 0 0; color: #333;">${log.message}</p>
            </div>
          `
            )
            .join("")}
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
        html: errorEmailTemplate,
      });
    } catch (emailError) {
      console.error("Failed to send error email:", emailError);
    }
  };

  try {
    let {
      startUrl,
      name,
      steps,
      testId,
      email,
      runId: requestRunId,
    } = req.body;
    runId = requestRunId; // Assign the runId from request to our top-level variable

    // Update testInfo with actual values
    testInfo = {
      name: name || "Unknown Test",
      testId: testId || "Unknown",
      startUrl: startUrl || "Unknown",
      email: email || "Unknown",
    };

    // Initialize stream run in Supabase
    await createStreamRun(runId);

    // Initialize addLog with runId
    initializeAddLog(runId);

    addLog(`Starting scenario: ${testInfo.name}`, "info");

    if (!startUrl || !steps || !name) {
      const error = new Error("Missing required parameters");
      try {
        await sendErrorEmail(error, testInfo, logs, screenShots);
        await addLog("Error: Missing required parameters", "error");
      } catch (logError) {
        console.error("Error in error handling:", logError);
      }
      return res.status(404).json({
        status: "error",
        message: "Something is missing",
        logs,
        screenShots,
        runId,
      });
    }

    console.log("Starting browser...........");
    const stagehand = new Stagehand({
      env: "LOCAL",
      modelName: "gpt-4o",
      localBrowserLaunchOptions: { headless: true },
      modelClientOptions: { apiKey: process.env.OPENAI_KEY },
    });
    await stagehand.init();
    const page = stagehand.page;

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

      // Calculate gpt-4o cost for stagehand tokens
      const gpt4oInputPrice = 2.5; // $2.50 per 1M input tokens
      const stagehandTokenCount = stagehand.metrics.totalPromptTokens || 0;
      const stagehandCost = (stagehandTokenCount / 1_000_000) * gpt4oInputPrice;
      const totalEstimatedCost = (tokenUsage.cost || 0) + stagehandCost;

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
                <p style="margin: 5px 0;"><strong>Total Tokens:</strong> ${tokenUsage.totalTokens + (stagehandTokenCount || 0)}</p>
                <p style="margin: 5px 0;"><strong>Estimated Cost:</strong> $${totalEstimatedCost.toFixed(4)}</p>
                ${tokenUsage.embeddingModel ? `<p style="margin: 5px 0;"><strong>Embedding Model:</strong> ${tokenUsage.embeddingModel}</p>` : ''}
                ${tokenUsage.executionModel ? `<p style="margin: 5px 0;"><strong>Execution Model:</strong> ${tokenUsage.executionModel}</p>` : ''}
              </div>
            </div>

            ${stagehandTokenCount ? `
            <div style="margin-bottom: 20px;">
              <h2 style="color: #333; margin-bottom: 10px;">Stagehand Model Usage</h2>
              <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px;">
                <p style="margin: 5px 0;"><strong>Stagehand Tokens:</strong> ${stagehandTokenCount}</p>
                <p style="margin: 5px 0;"><strong>Stagehand Cost:</strong> $${stagehandCost.toFixed(4)}</p>
              </div>
            </div>
            ` : ''}

            ${tokenUsage.stepBreakdown && tokenUsage.stepBreakdown.length > 0 ? `
            <div style="margin-bottom: 20px;">
              <h2 style="color: #333; margin-bottom: 10px;">Step-by-Step Token Usage</h2>
              <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px;">
                ${tokenUsage.stepBreakdown
                  .map(
                    (step) => `
                  <div style="margin-bottom: 10px; padding: 10px; border-left: 4px solid #2196F3; background-color: white;">
                    <p style="margin: 5px 0;"><strong>Step:</strong> ${step.step.type} - ${step.step.description}</p>
                    <p style="margin: 5px 0;"><strong>Tokens Used:</strong> ${step.tokens}</p>
                    <p style="margin: 5px 0;"><strong>Cost:</strong> $${step.cost}</p>
                    <p style="margin: 5px 0;"><strong>Model:</strong> ${step.model}</p>
                  </div>
                `
                  )
                  .join("")}
              </div>
            </div>
            ` : ''}

            ${
              screenShots.length > 0
                ? `
              <div style="margin-bottom: 20px;">
                <h2 style="color: #333; margin-bottom: 10px;">Last Screenshot</h2>
                <img src="${screenShots[screenShots.length - 1]}" alt="Last Screenshot" style="max-width: 100%; border-radius: 5px; border: 1px solid #ccc;" />
              </div>
            `
                : ""
            }

            <div>
              <h2 style="color: #333; margin-bottom: 10px;">Execution Logs</h2>
              ${logs
                .map(
                  (log) => `
                <div style="margin: 10px 0; padding: 10px; border-left: 4px solid ${getStatusColor(log.status)}; background-color: #f8f9fa;">
                  <div style="display: flex; align-items: center;">
                    <span style="margin-right: 10px;">${getStatusIcon(log.status)}</span>
                    <span style="color: ${getStatusColor(log.status)}; font-weight: bold;">${log.status.toUpperCase()}</span>
                    <span style="margin-left: auto; color: #666; font-size: 0.9em;">${log.timestamp}</span>
                  </div>
                  <p style="margin: 5px 0 0 0; color: #333;">${log.message}</p>
                </div>
              `
                )
                .join("")}
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
        html: emailTemplate,
      });
      console.log("=======================>", data);

      // Update final state in Supabase
      await updateStreamRun(runId, {
        logs: logs,
        screenshot: screenShots[screenShots.length - 1] || null,
      });

      return res.status(200).json({
        status: "success",
        screenShots,
        logs,
        steps: executedSteps,
        runId,
        tokenUsage: {
          totalTokens: tokenUsage.totalTokens + stagehandTokenCount,
          stagehandTokens: stagehandTokenCount,
          promptTokens: tokenUsage.promptTokens,
          completionTokens: tokenUsage.completionTokens,
          estimatedCost: totalEstimatedCost,
          embeddingModel: tokenUsage.embeddingModel,
          executionModel: tokenUsage.executionModel,
        },
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
        pushUniqueScreenshot(screenShots, finalErrorScreenshot);
      } catch (screenshotError) {
        console.error(
          "Failed to capture final error screenshot:",
          screenshotError
        );
      }

      try {
        await sendErrorEmail(error, testInfo, logs, screenShots);
        await addLog(`Error during test execution: ${error.message}`, "error");

        // Update the final state in Supabase before sending response
        await updateStreamRun(runId, {
          logs: logs,
          screenshot: screenShots[screenShots.length - 1] || null,
        });
      } catch (logError) {
        console.error("Error in error handling:", logError);
      }

      return res.status(500).json({
        status: "error",
        message: `Error during test execution: ${error.message}`,
        logs,
        screenShots,
        runId,
      });
    } finally {
      clearTimeout(executionTimeout);
      if (page) await page.close().catch(console.error);
      await stagehand.close();
    }
  } catch (error) {
    try {
      await sendErrorEmail(error, testInfo, logs, screenShots);
      await addLog(`Fatal error in run scenario: ${error.message}`, "error");

      // Update the final state in Supabase before sending response
      await updateStreamRun(runId, {
        logs: logs,
        screenshot: screenShots[screenShots.length - 1] || null,
      });
    } catch (logError) {
      console.error("Error in error handling:", logError);
    }

    return res.status(500).json({
      status: "error",
      message: `Something went wrong in run scenario: ${error.message}`,
      screenShots,
      logs,
      runId,
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
      // Update current URL in step for potential fallback embedding approach
      step.currentUrl = page.url();

      // Validate selector before proceeding
      if (!step.selector || step.selector.trim() === "") {
        console.log("Empty selector detected, fetching new selector...");
        const stepInfo = {
          type: step.actionType,
          description:
            step.actionType === "Click Element"
              ? step.details.element
              : step.details.description,
          attempt: attempt,
        };
        const selectorObject = await getSelector(
          page,
          step,
          name,
          screenshot,
          errmsg,
          tokenTracker,
          stepInfo,
          true // isRetryDueToFailedSelector = true
        );
        step.selector = selectorObject.selector;
        step.cache = false;
      }

      // Highlight the element before performing action
      await highlightElement(page, step.selector);
      // Capture screenshot after highlighting (before action)
      const screenshotBeforeAction = await captureAndStoreScreenshot(
        page,
        testId,
        step.id,
        runId
      );
      pushUniqueScreenshot(screenShots, screenshotBeforeAction);

      // Modified to handle multiple elements by selecting the visible one
      const elements = await page.locator(step.selector).all();
      if (elements.length > 1) {
        console.log(
          `Found ${elements.length} matching elements, checking visibility...`
        );
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
          console.log("Clicking visible element");
          await visibleElement.click();
        } else {
          // If no visible element found, try to make the element visible
          console.log(
            "No visible element found, attempting to make element visible"
          );
          await page.evaluate((selector) => {
            const elements = document.querySelectorAll(selector);
            for (const element of elements) {
              element.style.display = "block";
              element.style.visibility = "visible";
              element.style.opacity = "1";
            }
          }, step.selector);
          // Try clicking the first element after making it visible
          await elements[0].click();
        }
      } else if (elements.length === 0) {
        throw new Error(
          `No elements found matching selector: ${step.selector}`
        );
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
      pushUniqueScreenshot(screenShots, screenshotAfterAction);

      // Update cache after successful action
      step.cache = true;

      // Update the cache in the main steps array
      const stepIndex = clonedSteps.findIndex((s) => s.id === step.id);
      if (stepIndex !== -1) {
        clonedSteps[stepIndex].cache = true;
        clonedSteps[stepIndex].selector = step.selector;
        // Preserve the imageOnlyAttempted flag
        clonedSteps[stepIndex].imageOnlyAttempted = step.imageOnlyAttempted;

        // Update the database with the final working selector
        console.log(
          `Updating database with final working selector: ${step.selector}`
        );
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
        pushUniqueScreenshot(screenShots, errorScreenshot);
      } catch (screenshotError) {
        console.error("Failed to capture error screenshot:", screenshotError);
      }

      if (attempt < retries) {
        console.log(`Retrying to fetch selector for step ${step.selector}...`);
        console.log(
          `Before retry - step.imageOnlyAttempted: ${step.imageOnlyAttempted}`
        );
        try {
          // Update current URL in step for potential fallback embedding approach
          step.currentUrl = page.url();

          const stepInfo = {
            type: step.actionType,
            description:
              step.actionType === "Click Element"
                ? step.details.element
                : step.details.description,
            attempt: attempt + 1,
            retry: true,
          };

          const selectorObject = await getSelector(
            page,
            step,
            name,
            screenshot,
            errmsg,
            tokenTracker,
            stepInfo,
            true // isRetryDueToFailedSelector = true
          );
          if (!selectorObject || !selectorObject.selector) {
            throw new Error("Failed to get valid selector from getSelector");
          }
          step.selector = selectorObject.selector;
          // Reset cache when retrying with new selector
          step.cache = false;

          console.log(
            `After retry - step.imageOnlyAttempted: ${step.imageOnlyAttempted}`
          );

          // Update the cache in the main steps array
          const stepIndex = clonedSteps.findIndex((s) => s.id === step.id);
          if (stepIndex !== -1) {
            clonedSteps[stepIndex].cache = false;
            clonedSteps[stepIndex].selector = step.selector;
            // Preserve the imageOnlyAttempted flag
            clonedSteps[stepIndex].imageOnlyAttempted = step.imageOnlyAttempted;
            console.log(
              `Updated clonedSteps[${stepIndex}].imageOnlyAttempted to: ${clonedSteps[stepIndex].imageOnlyAttempted}`
            );

            // Update the database with the new selector
            console.log(
              `Updating database with new selector: ${step.selector}`
            );
            await updateTest(testId, clonedSteps);
          }
        } catch (errormsg) {
          errmsg = errormsg;
          console.error(`Failed to re-fetch selector`, errormsg);
          throw new Error(
            `Failed to get valid selector after ${attempt} attempts: ${errormsg.message}`
          );
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

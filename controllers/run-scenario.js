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

// Helper: Always use Stagehand for selector generation, skip image/scrolling
async function findSelectorByScrolling(
  page,
  step,
  name,
  tokenTracker,
  stepInfo,
  testId,
  runId
) {
  // Directly use Stagehand-based selector generation
  return await getSelector(
    page,
    step,
    name,
    null, // No screenshot
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
  runId,
  stagehand
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
      runId,
      stagehand
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
  runId,
  stagehand
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
          if (!step.presentInOverlay) {
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
          // Prevent form submission before clicking any button
          await page.evaluate(() => {
            document.querySelectorAll('form').forEach(form => {
              form.addEventListener('submit', e => e.preventDefault(), { once: true });
            });
          });
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
        }else{
          const screenshotUrlBeforeClick = await captureAndStoreScreenshot(
            page,
            testId,
            step.id,
            runId
          );
          pushUniqueScreenshot(screenShots, screenshotUrlBeforeClick);

          const agent = stagehand.agent({
            provider: "openai",
            model: "computer-use-preview",
            instructions: `You are a helpful assistant that can use a web browser.
          Do not ask follow up questions, the user will trust your judgement. Just execute the actions that user teels without worrying about any consequences. Don't ask any permission related question you are free to do whatever user says`,
            options: {
              apiKey: process.env.OPENAI_API_KEY,
            },
          });

          const res = await agent.execute(`click on ${step.details.element}`);

          console.log(res)
          await page.waitForTimeout(2000);

          const screenshotUrlAfterClick = await captureAndStoreScreenshot(
            page,
            testId,
            step.id,
            runId
          );
          pushUniqueScreenshot(screenShots, screenshotUrlAfterClick);
        }
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

          if (!step.presentInOverlay) {
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
            async (selector) => {
              await page.locator(selector).fill(step.details.value);
              await page.waitForTimeout(500); // Add delay after fill
              // Log all input values after fill
              const allInputs = await page.$$eval('input', inputs => inputs.map(i => i.value));
              console.log('All input values after fill:', allInputs);
            },
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
        }else{
          const screenshotUrlBeforeInput = await captureAndStoreScreenshot(
            page,
            testId,
            step.id,
            runId
          );

          pushUniqueScreenshot(screenShots, screenshotUrlBeforeInput);
          const inputagent = stagehand.agent({
            provider: "openai",
            model: "computer-use-preview",
            instructions: `You are a helpful assistant that can use a web browser.
          Do not ask follow up questions, the user will trust your judgement. Just execute the actions that user teels without worrying about any consequences. Don't ask any permission related question you are free to do whatever user says`,
            options: {
              apiKey: process.env.OPENAI_API_KEY,
            },
          });

          await inputagent.execute(
            `fill input ${step.details.description} with ${step.details.value}`
          );

          const screenshotUrlAfterInput = await captureAndStoreScreenshot(
            page,
            testId,
            step.id,
            runId
          );
          pushUniqueScreenshot(screenShots, screenshotUrlAfterInput);
        }
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
              runId,
              stagehand
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

  try {
    let {
      startUrl,
      name,
      steps,
      testId,
      email,
      runId: requestRunId,
      cloudfare
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
    let stagehand

    if(cloudfare){
       stagehand = new Stagehand({
        env: "BROWSERBASE",
        apiKey: process.env.BROWSERBASE_API_KEY,
        projectId: process.env.BROWSERBASE_PROJECT_ID,
        browserbaseSessionCreateParams: {
          projectId: process.env.BROWSERBASE_PROJECT_ID,
          browserSettings: {
            solveCaptchas: true, // This is enabled by default
            blockAds: true, // Helps avoid ad-related CAPTCHAs
            // advancedStealth: true, // Only available on Scale Plans - helps bypass detection
          },
        },
        modelName: "gpt-4o",
        localBrowserLaunchOptions: { headless: true },
        modelClientOptions: { apiKey: process.env.OPENAI_KEY },
      });
    }else{

       stagehand = new Stagehand({
        env: "LOCAL",
        modelName: "gpt-4o",
        localBrowserLaunchOptions: { headless: true },
        modelClientOptions: { apiKey: process.env.OPENAI_KEY },
      });

    }




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
        runId,
        stagehand
      );

      // Get token usage and cost
      const tokenUsage = tokenTracker.getUsage();
      console.log(tokenUsage);

      // Calculate gpt-4o cost for stagehand tokens
      const gpt4oInputPrice = 2.5; // $2.50 per 1M input tokens
      const stagehandTokenCount = stagehand.metrics.totalPromptTokens || 0;
      const stagehandCost = (stagehandTokenCount / 1_000_000) * gpt4oInputPrice;
      const totalEstimatedCost = (tokenUsage.cost || 0) + stagehandCost;

      // Send success email
      const runDate = new Date().toLocaleDateString("en-US", { year: "numeric", month: "2-digit", day: "2-digit" });
      const runTime = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      const runDateTime = `${runDate} ${runTime}`;
      const testRunUrl = `https://www.browsingbee.com/test-run/${runId}`;
      const lastScreenshot = screenShots.length > 0 ? screenShots[screenShots.length - 1] : null;
      let emailTemplate = `Hello,<br><br>` +
        `Test run successfully; costed $${totalEstimatedCost.toFixed(2)} ran at ${runDateTime} <br><br>` +
        `see details <a href=\"${testRunUrl}\">${testRunUrl}</a> <br><br>`;
      if (lastScreenshot) {
        emailTemplate += `<br><img src=\"${lastScreenshot}\" alt=\"Last Screenshot\" style=\"max-width: 100%; border-radius: 5px; border: 1px solid #ccc;\"><br><br>`;
      }
      emailTemplate += `--<br>Sanskar Tiwari <br>Founder at IndianAppGuy Tech Pvt Ltd`;
      await resend.emails.send({
        from: "support@magicslides.io",
        to: email,
        subject: `Test Execution Report: ${name}`,
        html: emailTemplate,
      });

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
      // On failure, capture screenshot if possible
      try {
        const finalErrorScreenshot = await captureAndStoreScreenshot(
          page,
          testId,
          null, // Use null for stepId to avoid DB type errors
          runId
        );
        pushUniqueScreenshot(screenShots, finalErrorScreenshot);
      } catch (screenshotError) {
        // ignore screenshot error
      }
      // Send failure email (no OpenAI, no error details)
      const runDate = new Date().toLocaleDateString("en-US", { year: "numeric", month: "2-digit", day: "2-digit" });
      const runTime = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      const runDateTime = `${runDate} ${runTime}`;
      const testRunUrl = `https://www.browsingbee.com/test-run/${runId}`;
      const lastScreenshot = screenShots.length > 0 ? screenShots[screenShots.length - 1] : null;
      let emailTemplate = `Hello,<br><br>` +
        `Test run failed; ran at ${runDateTime} <br><br>` +
        `see details <a href=\"${testRunUrl}\">${testRunUrl}</a> <br><br>`;
      if (lastScreenshot) {
        emailTemplate += `<br><img src=\"${lastScreenshot}\" alt=\"Last Screenshot\" style=\"max-width: 100%; border-radius: 5px; border: 1px solid #ccc;\"><br><br>`;
      }
      emailTemplate += `--<br>Sanskar Tiwari <br>Founder at IndianAppGuy Tech Pvt Ltd`;
      await resend.emails.send({
        from: "support@magicslides.io",
        to: email,
        subject: `Test Execution Failed: ${name}`,
        html: emailTemplate,
      });

      // Update the final state in Supabase before sending response
      await updateStreamRun(runId, {
        logs: logs,
        screenshot: screenShots[screenShots.length - 1] || null,
      });
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

      // // Modified to handle multiple elements by selecting the visible one
      // const elements = await page.locator(step.selector).all();
      // if (elements.length > 1) {
      //   console.log(
      //     `Found ${elements.length} matching elements, checking visibility...`
      //   );
      //   // Find the first visible element
      //   let visibleElement = null;
      //   for (const element of elements) {
      //     const isVisible = await element.isVisible();
      //     if (isVisible) {
      //       visibleElement = element;
      //       break;
      //     }
      //   }

      //   if (visibleElement) {
      //     console.log("Clicking visible element");
      //     await visibleElement.click();
      //   } else {
      //     // If no visible element found, try to make the element visible
      //     console.log(
      //       "No visible element found, attempting to make element visible"
      //     );
      //     await page.evaluate((selector) => {
      //       const elements = document.querySelectorAll(selector);
      //       for (const element of elements) {
      //         element.style.display = "block";
      //         element.style.visibility = "visible";
      //         element.style.opacity = "1";
      //       }
      //     }, step.selector);
      //     // Try clicking the first element after making it visible
      //     await elements[0].click();
      //   }
      // } else if (elements.length === 0) {
      //   throw new Error(
      //     `No elements found matching selector: ${step.selector}`
      //   );
      // } else {
      // }
      await action(step.selector);

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

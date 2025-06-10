import express from "express";
import cors from "cors";
import "dotenv/config.js";
import centralRoute from "./routers/router.js";
import https from "https";
import fs from "fs";
import path from "path";
import chokidar from "chokidar";
import { fileURLToPath } from 'url';
import { exec }  from "child_process";
const app = express();
const ecosystemPath = path.join("/var/www/app", "ecosystem.config.js");
let reloadTimeout;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Initialize watcher
const watcher = chokidar.watch(ecosystemPath, {
  persistent: true,
  awaitWriteFinish: {
    stabilityThreshold: 500,
    pollInterval: 100,
  },
});

// Setup watcher event handlers
watcher.on("change", (path) => {
  console.log(`Ecosystem file changed: ${path}`);

  // Clear any existing timeout
  if (reloadTimeout) {
    clearTimeout(reloadTimeout);
  }

  // Set new timeout for reload
  reloadTimeout = setTimeout(() => {
    console.log("Reloading PM2 application...");
    exec(
      "pm2 reload /var/www/app/ecosystem.config.js",
      (err, stdout, stderr) => {
        if (err) {
          console.error("Failed to reload PM2 application:", err);
          return;
        }
        console.log("PM2 application reloaded successfully");
        console.log("stdout:", stdout);
        if (stderr) {
          console.error("stderr:", stderr);
        }
      }
    );
  }, 2000); // 2 second delay
});

// Error handling for watcher
watcher.on("error", (error) => {
  console.error("Watcher error:", error);
});
const PORT = process.env.PORT || 3005;

// SSL/TLS Configuration for Let's Encrypt
// const options = {
//   key: fs.readFileSync("/etc/letsencrypt/live/browsingbee.co/privkey.pem"),
//   cert: fs.readFileSync("/etc/letsencrypt/live/browsingbee.co/fullchain.pem"),
// };

app.use(
  cors({
    origin:
      process.env.NODE_ENV === "production" ? ["https://browsingbee.co"] : true,
  })
);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

// Security headers
app.use((req, res, next) => {
  res.setHeader(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains"
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  next();
});

// Central Router
app.use("/", centralRoute);

// SSE endpoint for test execution streaming
app.get('/api/test-stream/:testId', (req, res) => {
  const testId = req.params.testId;
  
  // Set headers for SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // Store the response object in a global map for access from other parts of the application
  if (!global.testStreams) {
    global.testStreams = new Map();
  }
  global.testStreams.set(testId, res);

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected', testId })}\n\n`);

  // Handle client disconnect
  req.on('close', () => {
    global.testStreams.delete(testId);
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send("Something broke!");
});
app.get("/test", (req, res) => {
  res.send("testing...");
});
app.get("/env-dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "env-dashboard.html"));
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body;

  // Replace these with your secure values
  const correctEmail = "indianappguy.com";
  const correctPassword = "magicslides";

  if (email === correctEmail && password === correctPassword) {
    res.status(200).json({ success: true });
  } else {
    res.status(401).json({ success: false, message: "Invalid credentials" });
  }
});

// Endpoint to fetch current environment variables
app.get("/api/env", (req, res) => {
  const ecosystemPath = path.join("/var/www/app", "ecosystem.config.js");

  fs.readFile(ecosystemPath, "utf8", (err, data) => {
    if (err) {
      console.error("Failed to read ecosystem file:", err);
      return res.status(500).json({ error: "Failed to read ecosystem file" });
    }

    // Extract only the environment variables section
    const envVars = {};
    const envSectionMatch = data.match(/"env":\s*{([^}]*)}/);
    if (envSectionMatch) {
      const envSection = envSectionMatch[1];
      const envRegex = /"(\w+)":\s*"([^"]*)"/g;
      let match;
      while ((match = envRegex.exec(envSection)) !== null) {
        envVars[match[1]] = match[2];
      }
    }

    res.json(envVars);
  });
});

// Endpoint to update environment variables
app.post("/api/env", (req, res) => {
  const { newEnvVars } = req.body;
  const ecosystemPath = path.join("/var/www/app", "ecosystem.config.js");

  fs.readFile(ecosystemPath, "utf8", (err, data) => {
    if (err) {
      console.error("Failed to read ecosystem file:", err);
      return res.status(500).json({ error: "Failed to read ecosystem file" });
    }

    // Extract the "env" section, modify it based on `newEnvVars`, and rebuild the section
    const envSectionMatch = data.match(/("env":\s*{)([^}]*)(})/s);
    if (!envSectionMatch) {
      return res
        .status(500)
        .json({ error: "Failed to find env section in ecosystem file" });
    }

    const start = envSectionMatch[1]; // "env": {
    const end = envSectionMatch[3]; // }

    // Rebuild the "env" section with only the updated variables
    let updatedEnvSection = Object.entries(newEnvVars)
      .filter(([key, value]) => key && value) // Only include non-empty keys and values
      .map(([key, value]) => `    "${key}": "${value}"`)
      .join(",\n");

    // Construct the new ecosystem.config.js content
    const updatedData = data.replace(
      envSectionMatch[0],
      `${start}\n${updatedEnvSection}\n${end}`
    );

    // Write the updated configuration back to the ecosystem.config.js file
    fs.writeFile(ecosystemPath, updatedData, "utf8", (err) => {
      if (err) {
        console.error("Failed to write to ecosystem file:", err);
        return res
          .status(500)
          .json({ error: "Failed to write to ecosystem file" });
      }
      res.json({ message: "Environment variables updated successfully." });
    });
  });
});
// Create HTTPS server
// https.createServer(options, app).listen(PORT, () => {
//   console.log(`Secure server running on port ${PORT}`);
// });

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Optional: Redirect HTTP to HTTPS
// import http from "http";
// http
//   .createServer((req, res) => {
//     res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
//     res.end();
//   })
//   .listen(80);

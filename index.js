import express from "express";
import cors from "cors";
import "dotenv/config.js";
import centralRoute from "./routers/router.js";
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3005;

// SSL/TLS Configuration for Let's Encrypt
const options = {
  key: fs.readFileSync("/etc/letsencrypt/live/browsingbee.co/privkey.pem"),
  cert: fs.readFileSync("/etc/letsencrypt/live/browsingbee.co/fullchain.pem"),
};

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


// Create HTTPS server
https.createServer(options, app).listen(PORT, () => {
  console.log(`Secure server running on port ${PORT}`);
});

// Optional: Redirect HTTP to HTTPS
import http from "http";
http
  .createServer((req, res) => {
    res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
    res.end();
  })
  .listen(80);

import express from "express";
import RunScenario from "../controllers/run-scenario.js";
import { Testing } from "../controllers/testing.js";
import embedController from "../controllers/embbed.js";
import searchController from "../controllers/findChunks.js";
import extension from "../controllers/extension.js";
import createTest from "../controllers/createTest.js";
import updateTestData from "../controllers/updateTest.js";

const router = express.Router();
// embedController
router.post("/run-scenario", RunScenario);
router.post("/embbeding", embedController);
router.post("/findChunks", searchController);
router.post("/testing", Testing);
router.post("/extension", extension);
router.post("/createTest", createTest);
router.post("/updateTest", updateTestData);

export default router;

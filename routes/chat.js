import express from "express";
import { handleChat, healthCheck } from "../controllers/chatController.js";

const router = express.Router();

router.get("/health", healthCheck);
router.post("/chat", handleChat);

export default router;

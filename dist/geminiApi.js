"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.promptGemini = promptGemini;
const genai_1 = require("@google/genai");
require("dotenv/config");
const ai = new genai_1.GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});
async function promptGemini(prompt) {
    try {
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
        });
        return response.text;
    }
    catch (err) {
        console.error("API error:", err);
    }
}

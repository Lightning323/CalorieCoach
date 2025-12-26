import { GoogleGenAI } from "@google/genai";
import "dotenv/config";

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

export async function promptGemini(prompt:string) {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-lite",//gemini-2.5-flash
      contents: prompt,
    });
    return response.text;
  } catch (err) {
    console.error("API error:", err);
  }
}
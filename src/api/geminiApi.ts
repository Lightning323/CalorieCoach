import { GenerateContentConfig, GoogleGenAI } from "@google/genai";

if(!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY must be set in .env");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});


async function generateContent(
  model: "gemini-2.5-flash" | "gemini-2.5-flash-lite",
  prompt: string,
  config?: GenerateContentConfig,
) {
  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config,
  });

  if (process.env.DEBUG_AI_LOGGING === "true") {
    console.log(`\n${model}:\n\"`, response.text, "\"\n");
  }

  return response.text;
}

export async function promptGemini(prompt: string, config?: GenerateContentConfig) {
  try {
    return await generateContent("gemini-2.5-flash", prompt, config);
  } catch (e) {
    return generateContent("gemini-2.5-flash-lite", prompt, config);
  }
}

export async function promptGeminiLite(prompt: string, config?: GenerateContentConfig) {
  try {
    return await generateContent("gemini-2.5-flash-lite", prompt, config);
  } catch (e) {
    return generateContent("gemini-2.5-flash", prompt, config);
  }
}

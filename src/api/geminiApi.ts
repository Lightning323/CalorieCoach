import { GoogleGenAI } from "@google/genai";


const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

export async function promptGemini(prompt: string)  {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",//gemini-2.5-flash
      contents: prompt,
    });
    return response.text;
  } catch (e) {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-lite",//gemini-2.5-flash
      contents: prompt,
    });
    return response.text;
  }
}

export async function promptGeminiLite(prompt: string)  {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-lite",//gemini-2.5-flash
      contents: prompt,
    });
    return response.text;
  } catch (e) {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",//gemini-2.5-flash
      contents: prompt,
    });
    return response.text;
  }
}
import { GoogleGenAI } from "@google/genai";

const USE_LOCAL_LM_STUDIO = true;
const LM_STUDIO_BASE_URL = "http://localhost:1234/v1";
// const LM_STUDIO_MODEL = "qwen/qwen3.8-27b";
// const LM_STUDIO_MODEL = "google/gemma-4-e4b-it";
// const LM_STUDIO_MODEL = "google/gemma-4-12b-qat";
const LM_STUDIO_MODEL = "granite-4.1-8b";


const geminiApiKey = process.env.GEMINI_API_KEY;
const ai = geminiApiKey
  ? new GoogleGenAI({ apiKey: geminiApiKey })
  : undefined;

export async function generate(prompt: string): Promise<string> {
  return USE_LOCAL_LM_STUDIO
    ? generateLocalLmStudioContent(prompt)
    : generateGeminiContent(prompt);
}
export async function generateJson(
  prompt: string,
  attempts = 3,
): Promise<JSON> {
  let currentPrompt = prompt;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const raw = await generate(currentPrompt);

      const json = raw
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();

      let jsonOut = JSON.parse(json);
      return jsonOut;
    } catch (error) {
      lastError = error;
      currentPrompt = `${prompt}

Return only valid JSON. Do not include Markdown code fences or explanation.`;
    }
  }

  throw new Error(
    `AI failed to return valid JSON after ${attempts} attempts. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

async function generateGeminiContent(prompt: string): Promise<string> {
  if (!ai) {
    throw new Error(
      "GEMINI_API_KEY must be set in .env when Gemini is enabled."
    );
  }

  const model = "gemini-2.5-flash";

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      temperature: 0,
      maxOutputTokens: 1024,
    },
  });

  const text = response.text ?? "";

  if (process.env.DEBUG_AI_LOGGING === "true") {
    console.log(`\n${model}:\n"${text}"\n`);
  }

  return text;
}

type LmStudioResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

async function generateLocalLmStudioContent(
  prompt: string
): Promise<string> {
  const noThinkPrompt = `${prompt.trim()}\n/no_think`;

  const response = await fetch(
    `${LM_STUDIO_BASE_URL}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: LM_STUDIO_MODEL,
        messages: [
          {
            role: "user",
            content: noThinkPrompt,
          },
        ],
        temperature: 0,
        max_tokens: 1024,
        stream: false,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `LM Studio request failed: ${response.status} ${errorText}`
    );
  }

  const data = (await response.json()) as LmStudioResponse;
  const text = data.choices?.[0]?.message?.content ?? "";

  if (process.env.DEBUG_AI_LOGGING === "true") {
    console.log(`\n${LM_STUDIO_MODEL}:\n"${text}"\n`);
  }

  return text;
}
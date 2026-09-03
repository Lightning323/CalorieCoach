import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

export type LlmProvider = "lmstudio" | "gemini" | "groq";


const LM_STUDIO_MODEL = process.env.LM_STUDIO_MODEL ?? "gemma-4-e4b";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const GROQ_MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-20b";

const LM_STUDIO_BASE_URL = process.env.LM_STUDIO_BASE_URL ?? "http://localhost:1234/v1";
const GROQ_BASE_URL = (process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/+$/, "");

const MAX_OUTPUT_TOKENS = 1024;

const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
const ai = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : undefined;

/**
 * Resolves the configured provider. LLM_PROVIDER defaults to LM Studio to
 * preserve the previous local-first behavior.
 */
export function resolveLlmProvider(value = process.env.LLM_PROVIDER): LlmProvider {
  const provider = value?.trim().toLowerCase() || "lmstudio";
  switch (provider) {
    case "lmstudio":
    case "lm-studio":
    case "lm_studio":
    case "local":
      return "lmstudio";
    case "gemini":
      return "gemini";
    case "groq":
      return "groq";
    default:
      throw new Error("LLM_PROVIDER must be one of: lmstudio, gemini, groq.");
  }
}

export async function generate(prompt: string): Promise<string> {
  switch (resolveLlmProvider()) {
    case "lmstudio":
      return generateLocalLmStudioContent(prompt);
    case "gemini":
      return generateGeminiContent(prompt);
    case "groq":
      return generateGroqContent(prompt);
  }
}

export async function generateJson(
  prompt: string,
  attempts = 3,
): Promise<JSON> {
  let currentPrompt = prompt;
  let lastError: unknown;

  // for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const raw = await generate(currentPrompt);
      const json = raw
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
        console.log(" ATTEMPT \""+json+"\"");

      return JSON.parse(json) as JSON;
    } catch (error) {
      lastError = error;
//       currentPrompt = `${prompt}
// Return only valid JSON. Do not include Markdown code fences or explanation.`;
    }
  // }

  throw new Error(
    `AI failed to return valid JSON after ${attempts} attempts. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function generateGeminiContent(prompt: string): Promise<string> {
  if (!ai) {
    throw new Error("GEMINI_API_KEY must be set when LLM_PROVIDER=gemini.");
  }

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
      temperature: 0,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  });

  return logGeneratedText("Gemini", GEMINI_MODEL, response.text ?? "");
}

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

async function generateGroqContent(prompt: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GROQ_API_KEY must be set when LLM_PROVIDER=groq.");
  }

  return generateOpenAiCompatibleContent({
    provider: "Groq",
    baseUrl: GROQ_BASE_URL,
    model: GROQ_MODEL,
    prompt,
    authorization: `Bearer ${apiKey}`,
  });
}

async function generateLocalLmStudioContent(prompt: string): Promise<string> {
  return generateOpenAiCompatibleContent({
    provider: "LM Studio",
    baseUrl: LM_STUDIO_BASE_URL.replace(/\/+$/, ""),
    model: LM_STUDIO_MODEL,
    // /no_think is a local LM Studio prompt directive; it is intentionally
    // never sent to hosted providers.
    prompt: `${prompt.trim()}\n/no_think`,
  });
}

async function generateOpenAiCompatibleContent(options: {
  provider: string;
  baseUrl: string;
  model: string;
  prompt: string;
  authorization?: string;
}): Promise<string> {
  const response = await fetch(`${options.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.authorization ? { Authorization: options.authorization } : {}),
    },
    body: JSON.stringify({
      model: options.model,
      messages: [{ role: "user", content: options.prompt }],
      temperature: 0,
      max_tokens: MAX_OUTPUT_TOKENS,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${options.provider} request failed: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  return logGeneratedText(options.provider, options.model, data.choices?.[0]?.message?.content ?? "");
}

function logGeneratedText(provider: string, model: string, text: string): string {
  if (process.env.DEBUG_AI_LOGGING === "true") {
    console.log(`\n${provider} (${model}):\n"${text}"\n`);
  }
  return text;
}

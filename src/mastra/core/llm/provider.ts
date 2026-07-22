import "dotenv/config";
import { groq } from "@ai-sdk/groq";
import { createOpenAI, openai } from "@ai-sdk/openai";

const apiVersion =
  process.env.AZURE_OPENAI_API_VERSION?.trim() || "2024-08-01-preview";

const resourceName =
  process.env.AZURE_RESOURCE_NAME ||
  process.env.AZURE_OPENAI_ENDPOINT?.match(/https?:\/\/([^.]+)\.openai\.azure\.com/)?.[1];

const azureConfigured = !!resourceName && !!process.env.AZURE_OPENAI_API_KEY;
const groqConfigured = !!process.env.GROQ_API_KEY;

const providers = new Map<string, ReturnType<typeof createOpenAI>>();

function getAzureProvider(deployment: string): ReturnType<typeof createOpenAI> {
  if (providers.has(deployment)) {
    return providers.get(deployment)!;
  }

  const baseURL = `https://${resourceName}.openai.azure.com/openai/deployments/${deployment}`;

  const provider = createOpenAI({
    baseURL,
    apiKey: process.env.AZURE_OPENAI_API_KEY!,
    fetch(url, init) {
      const resolvedUrl = new URL(
        typeof url === "string"
          ? url
          : url instanceof URL
            ? url.href
            : (url as Request).url,
      );

      resolvedUrl.searchParams.set("api-version", apiVersion);

      return globalThis.fetch(resolvedUrl.toString(), init);
    },
  });

  providers.set(deployment, provider);

  return provider;
}

export function getChatModel(modelName = process.env.OPENAI_MODEL || "gpt-4o-mini") {
  if (azureConfigured) {
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || process.env.AZURE_DEPLOYMENT_NAME || modelName;
    return getAzureProvider(deployment).chat(deployment);
  }

  if (groqConfigured) {
    const groqModel = process.env.GROQ_MODEL || process.env.OPENAI_MODEL || "llama-3.1-8b-instant";
    return groq(groqModel);
  }

  return openai(modelName);
}

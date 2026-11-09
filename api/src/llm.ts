import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export type Provider = "openai" | "anthropic";
export interface ChatTurn { role: "user" | "assistant"; content: string }

type ModelErrorCategory = "auth" | "rate_limit" | "refusal" | "truncated" | "bad_json" | "upstream";
export class ModelError extends Error {
  category: ModelErrorCategory;
  constructor(category: ModelErrorCategory, message: string) { super(message); this.category = category; }
}

/**
 * One structured-output call. The key is used for this request only: it is
 * never stored, logged, or attached to errors we surface.
 */
export async function structuredCall(opts: {
  provider: Provider;
  apiKey: string;
  model: string;
  system: string;
  messages: ChatTurn[];
  schemaName: string;
  schema: object;
}): Promise<unknown> {
  const { provider, apiKey, model, system, messages, schemaName, schema } = opts;
  let text: string;
  try {
    if (provider === "anthropic") {
      const client = new Anthropic({ apiKey, maxRetries: 1 });
      const res = await client.messages.create({
        model,
        max_tokens: 16000,
        system,
        messages,
        output_config: { format: { type: "json_schema", schema: schema as Record<string, unknown> } },
      } as Anthropic.MessageCreateParamsNonStreaming);
      if (res.stop_reason === "refusal") throw new ModelError("refusal", "The model declined this request.");
      if (res.stop_reason === "max_tokens") throw new ModelError("truncated", "The model response was cut off.");
      text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    } else {
      const client = new OpenAI({ apiKey, maxRetries: 1 });
      const res = await client.responses.create({
        model,
        instructions: system,
        input: messages,
        text: { format: { type: "json_schema", name: schemaName, schema: schema as Record<string, unknown>, strict: true } },
      });
      if (res.status === "incomplete") throw new ModelError("truncated", "The model response was cut off.");
      text = res.output_text;
    }
  } catch (e) {
    if (e instanceof ModelError) throw e;
    const status = (e as { status?: number }).status;
    if (status === 401 || status === 403) throw new ModelError("auth", "The provider rejected the API key.");
    if (status === 429) throw new ModelError("rate_limit", "The provider rate-limited this request.");
    throw new ModelError("upstream", `The provider returned an error${status ? ` (${status})` : ""}.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ModelError("bad_json", "The model returned malformed JSON.");
  }
}

import { LlmProviderError } from "./llm-provider-error.js";

/** Parse plain or fenced JSON, optionally slicing away surrounding prose. */
export function parseLlmJson(text: string, providerId: string): unknown {
  let raw = text.trim();
  const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i);
  if (fenced?.[1]) raw = fenced[1].trim();
  const candidates = [raw, sliceToOuterBrackets(raw)];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next representation before returning a normalized error.
    }
  }
  throw new LlmProviderError(
    providerId,
    "invalid_response",
    `${providerId} did not return valid JSON`,
  );
}

function sliceToOuterBrackets(raw: string): string {
  const starts = [raw.indexOf("{"), raw.indexOf("[")].filter((i) => i >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  const end = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"));
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
}

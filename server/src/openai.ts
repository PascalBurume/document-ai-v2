import { HttpError, withRetry } from './mistral.js';

const RESPONSES_API = 'https://api.openai.com/v1/responses';

/**
 * The current multimodal reasoning model used for visual reconstruction, comparison, reading, and
 * teaching. Read lazily because dotenv is initialized after this module is imported by index.ts.
 */
export const openaiVisionModelName = () => process.env.OPENAI_VISION_MODEL || 'gpt-5.6';

interface OpenAIResponse {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  error?: { message?: string };
  message?: string;
}

/** Extract text from both the REST response shape and SDK-style output_text fixtures. */
export function openAIResponseText(data: OpenAIResponse): string {
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
  return (data.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

export function buildOpenAIVisionBody(
  instructions: string,
  userText: string,
  images: string[],
  maxOutputTokens: number,
) {
  return {
    model: openaiVisionModelName(),
    instructions,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: userText },
        ...images.map((image_url) => ({ type: 'input_image', image_url, detail: 'original' })),
      ],
    }],
    max_output_tokens: maxOutputTokens,
    store: false,
  };
}

/**
 * One OpenAI Responses API call with one or more image inputs. The prompt owns the output schema;
 * callers already parse defensively and surface malformed replies instead of silently trusting them.
 */
export async function callOpenAIVision(
  instructions: string,
  userText: string,
  images: string | string[],
  maxOutputTokens = 2000,
): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new HttpError(400, 'OPENAI_API_KEY is not set on the server.');

  const list = Array.isArray(images) ? images : [images];
  if (!list.length || list.some((image) => !image?.startsWith('data:image'))) {
    throw new HttpError(400, 'An image (data:image/...) is required.');
  }

  const res = await withRetry('reading an image with OpenAI', 3, () =>
    fetch(RESPONSES_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(buildOpenAIVisionBody(instructions, userText, list, maxOutputTokens)),
    }),
  );

  const data = (await res.json().catch(() => ({}))) as OpenAIResponse;
  if (!res.ok) {
    const detail = data.error?.message || data.message || JSON.stringify(data).slice(0, 300);
    throw new HttpError(res.status, `OpenAI vision failed (${res.status}): ${detail}`);
  }
  return openAIResponseText(data);
}

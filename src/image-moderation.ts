const OPENAI_MODERATIONS_URL = 'https://api.openai.com/v1/moderations';

export type ModerationResult = { allowed: boolean };

export async function moderateImage(
  imageDataUrl: string,
  apiKey: string,
  fetcher: typeof fetch = fetch
): Promise<ModerationResult> {
  const response = await fetcher(OPENAI_MODERATIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'omni-moderation-latest',
      input: [{ type: 'image_url', image_url: { url: imageDataUrl } }]
    }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`openai_moderation_${response.status}`);
  const payload = await response.json() as { results?: Array<{ flagged?: boolean }> };
  const result = payload.results?.[0];
  if (!result || typeof result.flagged !== 'boolean') throw new Error('invalid_openai_moderation_response');
  return { allowed: !result.flagged };
}

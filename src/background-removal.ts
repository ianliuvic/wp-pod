const REPLICATE_PREDICTIONS_URL = 'https://api.replicate.com/v1/predictions';
const BACKGROUND_REMOVER_VERSION = 'a029dff38972b5fda4ec5d75d7d1cd25aeff621d2cf4946a41055d7db66b80bc';

type Prediction = {
  status?: string;
  output?: string | null;
  error?: string | null;
  urls?: { get?: string };
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function predictionJson(response: Response): Promise<Prediction> {
  if (!response.ok) throw new Error(`replicate_${response.status}`);
  return await response.json() as Prediction;
}

export async function removeImageBackground(
  image: string,
  apiToken: string,
  fetcher: typeof fetch = fetch,
  pollDelayMs = 500
): Promise<string> {
  let prediction = await predictionJson(await fetcher(REPLICATE_PREDICTIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      Prefer: 'wait=30'
    },
    body: JSON.stringify({
      version: BACKGROUND_REMOVER_VERSION,
      input: { image, format: 'png', threshold: 0, reverse: false, background_type: 'rgba' }
    }),
    signal: AbortSignal.timeout(35_000)
  }));

  const deadline = Date.now() + 45_000;
  while (prediction.status === 'starting' || prediction.status === 'processing') {
    if (!prediction.urls?.get || Date.now() >= deadline) throw new Error('replicate_timeout');
    await pause(pollDelayMs);
    prediction = await predictionJson(await fetcher(prediction.urls.get, {
      headers: { Authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(10_000)
    }));
  }
  if (prediction.status !== 'succeeded' || typeof prediction.output !== 'string') {
    throw new Error(prediction.error || `replicate_${prediction.status || 'invalid_response'}`);
  }
  return prediction.output;
}

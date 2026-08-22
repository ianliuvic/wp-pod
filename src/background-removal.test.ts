import { describe, expect, it, vi } from 'vitest';
import { removeImageBackground } from './background-removal.js';

describe('background removal', () => {
  it('returns the transparent output from a completed prediction', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'succeeded', output: 'https://replicate.delivery/output.png'
    }), { status: 200 }));
    await expect(removeImageBackground('data:image/webp;base64,AAAA', 'test-token', fetcher)).resolves.toBe('https://replicate.delivery/output.png');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
      version: expect.stringMatching(/^[a-f0-9]{64}$/),
      input: { format: 'png', threshold: 0, background_type: 'rgba' }
    });
  });

  it('polls a cold prediction until it succeeds', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'processing', urls: { get: 'https://api.replicate.com/predictions/1' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'succeeded', output: 'https://replicate.delivery/output.png' }), { status: 200 }));
    await expect(removeImageBackground('data:image/webp;base64,AAAA', 'test-token', fetcher, 0)).resolves.toContain('output.png');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('fails closed when Replicate rejects or fails the prediction', async () => {
    const rejected = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    const failed = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'failed', error: 'model failed' }), { status: 200 }));
    await expect(removeImageBackground('data:image/webp;base64,AAAA', 'test-token', rejected)).rejects.toThrow('replicate_401');
    await expect(removeImageBackground('data:image/webp;base64,AAAA', 'test-token', failed)).rejects.toThrow('model failed');
  });
});

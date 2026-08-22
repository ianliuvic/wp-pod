import { describe, expect, it, vi } from 'vitest';
import { moderateImage } from './image-moderation.js';

describe('image moderation', () => {
  it('allows an image when OpenAI does not flag it', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [{ flagged: false }] }), { status: 200 }));
    await expect(moderateImage('data:image/webp;base64,AAAA', 'test-key', fetcher)).resolves.toEqual({ allowed: true });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ model: 'omni-moderation-latest' });
  });

  it('blocks an image when OpenAI flags it', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [{ flagged: true }] }), { status: 200 }));
    await expect(moderateImage('data:image/webp;base64,AAAA', 'test-key', fetcher)).resolves.toEqual({ allowed: false });
  });

  it('fails closed when OpenAI returns an error or malformed response', async () => {
    const failed = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    const malformed = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(moderateImage('data:image/webp;base64,AAAA', 'test-key', failed)).rejects.toThrow('openai_moderation_500');
    await expect(moderateImage('data:image/webp;base64,AAAA', 'test-key', malformed)).rejects.toThrow('invalid_openai_moderation_response');
  });
});

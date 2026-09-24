import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

// Exercise the shipped functions, not a duplicate cache implementation.
const html = readFileSync(new URL('../public/vendor/v3/renderer-frame.html', import.meta.url), 'utf8');
const functions = ['trimCache', 'surfaceCacheKey', 'imageCanvas'].map(name => {
  const line = html.split('\n').find(line => line.startsWith(`  function ${name}(`));
  assert.ok(line, `Missing production function ${name}`);
  return line;
}).join('\n');

function harness() {
  const pending = [];
  let decodes = 0;
  class Image {
    naturalWidth = 1042;
    naturalHeight = 1200;
    set src(value) {
      this.source = value;
      if (value) { decodes++; pending.push(this); }
    }
  }
  const context = vm.createContext({ Image, document: { createElement() {
    const canvas = { width: 0, height: 0 };
    canvas.getContext = () => ({ drawImage(image) { canvas.decodedSource = image.source; } });
    return canvas;
  } } });
  vm.runInContext(`var surfaceCache = new Map();\n${functions}`, context);
  return {
    context,
    decode: (source, w = 1042, h = 1200) => context.imageCanvas(source, w, h),
    flush() { for (const image of pending.splice(0)) image.onload(); },
    fail() { pending.shift().onerror(); },
    get count() { return decodes; },
  };
}

function oldFingerprint(source) {
  const step = Math.max(1, Math.floor(source.length / 96));
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += step) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${source.length}:${hash >>> 0}`;
}

// Mirrors the incident: length 3751, differences only at offsets 3582..3584.
const white = 'data:image/webp;base64,' + 'A'.repeat(3751 - 23);
const black = white.slice(0, 3582) + 'BCD' + white.slice(3585);

test('sampled collision cannot reuse another color decode', async () => {
  assert.equal(white.length, 3751);
  assert.notEqual(white, black);
  assert.equal(oldFingerprint(white), oldFingerprint(black));
  const h = harness();
  const a = h.decode(white), b = h.decode(black);
  assert.notEqual(a, b);
  h.flush();
  assert.equal((await a).decodedSource, white);
  assert.equal((await b).decodedSource, black);
  assert.equal(h.count, 2);
});

test('identical source and dimensions reuse pending and completed decode', async () => {
  const h = harness(), first = h.decode(black);
  assert.equal(h.decode(black), first);
  h.flush(); await first;
  assert.equal(h.decode(black), first);
  const resized = h.decode(black, 500, 600);
  assert.notEqual(resized, first);
  h.flush();
  assert.equal((await resized).width, 500);
  assert.equal((await resized).height, 600);
  assert.equal(h.count, 2);
});

test('LRU remains bounded to 12 entries and refreshes hits', async () => {
  const h = harness();
  const entries = Array.from({ length: 12 }, (_, i) => h.decode(`source-${i}`));
  h.flush(); await Promise.all(entries);
  assert.equal(h.decode('source-0'), entries[0]);
  const extra = h.decode('source-12'); h.flush(); await extra;
  assert.equal(h.context.surfaceCache.size, 12);
  assert.equal(h.decode('source-0'), entries[0]);
  const evicted = h.decode('source-1');
  assert.notEqual(evicted, entries[1]);
  h.flush(); await evicted;
  assert.equal(h.context.surfaceCache.size, 12);
});

test('stale decode map guard returns a released 1x1 canvas', async () => {
  const h = harness(), old = h.decode(black);
  vm.runInContext('surfaceCache = new Map()', h.context);
  const fresh = h.decode(black);
  h.flush();
  const stale = await old;
  assert.equal(stale.width, 1);
  assert.equal(stale.height, 1);
  assert.equal(stale.decodedSource, undefined);
  assert.equal((await fresh).decodedSource, black);
  assert.equal(h.context.surfaceCache.size, 1);
});

test('failed decode is evicted and can retry', async () => {
  const h = harness(), bad = h.decode(black);
  const rejected = assert.rejects(bad, /could not be decoded/);
  h.fail(); await rejected;
  assert.equal(h.context.surfaceCache.size, 0);
  const retry = h.decode(black); h.flush();
  assert.equal((await retry).decodedSource, black);
});

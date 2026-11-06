import { describe, expect, it } from 'vitest';
import { Downsampler, toPcm16 } from '../src/sidepanel/recorder';

describe('lecture audio conversion', () => {
  it('48 kHz → 16 kHz keeps the length and the level', () => {
    const d = new Downsampler(48000 / 16000);
    const out: number[] = [];
    // one second in blocks of 4096, as the ScriptProcessor delivers it
    const all = new Float32Array(48000).fill(0.5);
    for (let i = 0; i < all.length; i += 4096) d.push(all.subarray(i, i + 4096), out);
    expect(out.length).toBe(16000);
    expect(out.every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
  });

  it('44.1 kHz (a fractional ratio) does not drift', () => {
    const d = new Downsampler(44100 / 16000);
    const out: number[] = [];
    for (let s = 0; s < 60; s++) d.push(new Float32Array(44100), out);
    expect(Math.abs(out.length - 60 * 16000)).toBeLessThanOrEqual(1);
  });

  it('PCM16 is clipped, not wrapped around', () => {
    const pcm = new Int16Array(toPcm16([0, 1, -1, 2, -2, 0.5]));
    expect(Array.from(pcm)).toEqual([0, 32767, -32768, 32767, -32768, 16383]);
  });
});

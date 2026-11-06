// Records the sound of a tab or of the whole screen (Chrome's "share" picker), converts it to
// 16 kHz mono 16-bit PCM and hands it out in small pieces. The bridge transcribes it live.

export const TARGET_RATE = 16_000;

export class NoAudioError extends Error {}

export interface RecorderEvents {
  /** a piece of PCM to send (16 kHz mono s16le) */
  onChunk(pcm: ArrayBuffer): void;
  /** 0..1 loudness of the last moment, for the level meter */
  onLevel?(level: number): void;
  /** the user pressed "Stop sharing" in Chrome or closed the shared tab */
  onEnded?(): void;
}

/** Box-filter downsampler from the context rate to 16 kHz (enough for speech). */
export class Downsampler {
  private acc = 0;
  private n = 0;
  private pos = 0;
  constructor(private readonly ratio: number) {}

  push(input: Float32Array, out: number[]): void {
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i];
      this.n++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        out.push(this.acc / this.n);
        this.acc = 0;
        this.n = 0;
      }
    }
  }
}

export function toPcm16(samples: number[]): ArrayBuffer {
  const buf = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return buf.buffer;
}

export class Recorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private proc: ScriptProcessorNode | null = null;
  private pending: number[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  /** what Chrome says was shared: "tab" / "window" / "monitor" */
  surface = '';
  label = '';

  constructor(private readonly ev: RecorderEvents, private readonly flushMs = 2000) {}

  /** Opens Chrome's picker. Must be called from a click. */
  async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      // Chrome needs video in the request; it is stopped right away
      video: { frameRate: 1, width: 320, height: 240 },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      // hints for the picker: allow sharing system audio, don't offer this panel itself
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    } as DisplayMediaStreamOptions);
    const audio = stream.getAudioTracks()[0];
    const video = stream.getVideoTracks()[0];
    this.surface = (video?.getSettings() as { displaySurface?: string } | undefined)?.displaySurface ?? '';
    this.label = video?.label ?? audio?.label ?? '';
    if (!audio) {
      stream.getTracks().forEach((t) => t.stop());
      throw new NoAudioError(
        this.surface === 'window'
          ? 'У отдельного окна Chrome не может взять звук. Выберите вкладку (и отметьте «Поделиться звуком вкладки») или «Весь экран» с «Поделиться системным звуком».'
          : 'Звук не выбран. В окне выбора отметьте «Поделиться звуком вкладки» (или «системным звуком» для всего экрана).',
      );
    }
    this.stream = stream;
    audio.addEventListener('ended', () => this.handleEnded());
    // the picture is not needed; the sound keeps going without it
    video?.stop();

    const ctx = new AudioContext();
    this.ctx = ctx;
    const src = ctx.createMediaStreamSource(new MediaStream([audio]));
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    this.proc = proc;
    const down = new Downsampler(ctx.sampleRate / TARGET_RATE);
    proc.onaudioprocess = (e) => {
      if (this.stopped) return;
      const data = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      this.ev.onLevel?.(Math.min(1, Math.sqrt(sum / data.length) * 4));
      down.push(data, this.pending);
    };
    src.connect(proc);
    // a ScriptProcessor only runs when connected to the output; it writes silence there
    proc.connect(ctx.destination);
    this.timer = setInterval(() => this.flush(), this.flushMs);
  }

  private flush(): void {
    if (!this.pending.length) return;
    const pcm = toPcm16(this.pending);
    this.pending = [];
    this.ev.onChunk(pcm);
  }

  private handleEnded(): void {
    if (this.stopped) return;
    this.stop();
    this.ev.onEnded?.();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.flush();
    this.proc?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => undefined);
  }
}

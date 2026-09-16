declare module 'virtual:dockview.css';

/** "development" (dev server), "preview" / "production" (Vercel), or "local" (a local build). */
declare const __BENCH_ENV__: string;
/** The git branch a Vercel build came from; empty otherwise. */
declare const __BENCH_REF__: string;
declare const __BENCH_VERSION__: string;

interface HTMLVideoElement {
  requestVideoFrameCallback(callback: (now: number) => void): number;
}

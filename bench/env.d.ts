declare module 'virtual:dockview.css';

interface HTMLVideoElement {
  requestVideoFrameCallback(callback: (now: number) => void): number;
}

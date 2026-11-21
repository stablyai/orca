import { NATIVE_CHAT_NOTE_MAX_FRAMES } from '../native-chat-media-notes'

/** Notes this close in time are on the same frame, as `groupNativeChatNotesByFrame` groups them. */
const SAME_FRAME_SECONDS = 0.02

export type NativeChatVideoRect = { x: number; y: number; width: number; height: number }

/** Where a video's picture sits inside its element under `object-fit: contain`, in the element's
 *  own coordinates: the frame without the letterbox bars. */
export function nativeChatVideoContentRect(
  box: { width: number; height: number },
  video: { width: number; height: number }
): NativeChatVideoRect {
  if (box.width <= 0 || box.height <= 0 || video.width <= 0 || video.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  const scale = Math.min(box.width / video.width, box.height / video.height)
  const width = video.width * scale
  const height = video.height * scale
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height }
}

/** A note's time: the playhead to the millisecond, so the same paused frame always matches. */
export function nativeChatVideoNoteTime(currentTime: number): number {
  return Math.round(currentTime * 1000) / 1000
}

export function nativeChatSameVideoFrame(a: number | undefined, b: number | undefined): boolean {
  return a !== undefined && b !== undefined && Math.abs(a - b) < SAME_FRAME_SECONDS
}

export type NativeChatVideoSnapshot = { time: number; png: Blob; width: number; height: number }

/** The clean frames captured for a video's notes: each frame once, before any mark is drawn on it.
 *  Kept: every frame a note is on, plus the last one captured; older unused ones are dropped. */
export class NativeChatVideoSnapshots {
  private readonly frames: NativeChatVideoSnapshot[] = []

  find(time: number): NativeChatVideoSnapshot | undefined {
    return this.frames.find((frame) => nativeChatSameVideoFrame(frame.time, time))
  }

  /** Keeps `snapshot`, dropping frames no note uses except the newest. */
  add(snapshot: NativeChatVideoSnapshot, usedTimes: readonly number[]): void {
    const existing = this.frames.findIndex((frame) =>
      nativeChatSameVideoFrame(frame.time, snapshot.time)
    )
    if (existing !== -1) {
      this.frames.splice(existing, 1)
    }
    this.frames.push(snapshot)
    this.prune(usedTimes)
  }

  prune(usedTimes: readonly number[]): void {
    const newest = this.frames.at(-1)
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index]!
      const used = usedTimes.some((time) => nativeChatSameVideoFrame(time, frame.time))
      if (!used && frame !== newest) {
        this.frames.splice(index, 1)
      }
    }
    // Never more than the frames a message may carry, plus the one just captured.
    while (this.frames.length > NATIVE_CHAT_NOTE_MAX_FRAMES + 1) {
      this.frames.shift()
    }
  }

  list(): readonly NativeChatVideoSnapshot[] {
    return [...this.frames]
  }

  get size(): number {
    return this.frames.length
  }
}

/** A video whose length isn't known (a recording still being written) can't be moved to a time. */
export function nativeChatVideoSeekable(video: Pick<HTMLVideoElement, 'duration'>): boolean {
  return Number.isFinite(video.duration) && video.duration > 0
}

/** Moves `video` to `time` and resolves once that frame is on screen. */
export async function seekNativeChatVideo(video: HTMLVideoElement, time: number): Promise<void> {
  if (!nativeChatSameVideoFrame(video.currentTime, time)) {
    await new Promise<void>((resolve, reject) => {
      const done = (): void => {
        video.removeEventListener('seeked', done)
        video.removeEventListener('error', fail)
        resolve()
      }
      const fail = (): void => {
        video.removeEventListener('seeked', done)
        video.removeEventListener('error', fail)
        reject(new Error('The video could not move to that time'))
      }
      video.addEventListener('seeked', done)
      video.addEventListener('error', fail)
      video.currentTime = time
    })
  }
  await nextVideoFrame(video)
}

/** Resolves once the video's current frame has been presented. */
export function nextVideoFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    if (typeof video.requestVideoFrameCallback === 'function' && !video.paused) {
      video.requestVideoFrameCallback(() => resolve())
      return
    }
    // A paused video presents no new frames: two animation frames let the seeked one paint.
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

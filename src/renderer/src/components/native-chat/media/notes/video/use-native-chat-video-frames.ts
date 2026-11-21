import { useCallback, useEffect, useRef, useState } from 'react'
import { formatNativeChatNoteTime, type NativeChatMediaNote } from '../native-chat-media-notes'
import type { NativeChatNotesFrameSource } from '../native-chat-notes-handoff'
import {
  NativeChatVideoSnapshots,
  nativeChatVideoSeekable,
  nextVideoFrame,
  seekNativeChatVideo,
  type NativeChatVideoSnapshot
} from './native-chat-video-frames'

/** The frame a note is on can't be read again: the video can't move to its time any more. */
export class NativeChatVideoFrameUnavailable extends Error {
  constructor() {
    super('This video frame can’t be shown again')
  }
}

/** The capture rect: the frame's on-screen box, inset to whole pixels so no letterbox edge shows. */
function frameRect(layer: HTMLElement): { x: number; y: number; width: number; height: number } {
  const box = layer.getBoundingClientRect()
  const x = Math.ceil(box.left)
  const y = Math.ceil(box.top)
  return { x, y, width: Math.floor(box.right) - x, height: Math.floor(box.bottom) - y }
}

/** Captures the frame under `layer` as PNG, unless the video moved off `time` meanwhile. */
async function captureNativeChatVideoSnapshot(
  video: HTMLVideoElement,
  layer: HTMLElement,
  time: number,
  stillCurrent: () => boolean
): Promise<NativeChatVideoSnapshot | null> {
  const captureFrame = window.api.nativeChat.captureFrame
  if (!captureFrame) {
    return null
  }
  try {
    await nextVideoFrame(video)
    // A copy into a plain ArrayBuffer: IPC may hand back a view over a shared buffer.
    const png = new Blob([new Uint8Array(await captureFrame(frameRect(layer)))], {
      type: 'image/png'
    })
    // A seek since this capture started means the picture is no longer that frame.
    if (!stillCurrent() || Math.abs(video.currentTime - time) > 0.05) {
      return null
    }
    const bitmap = await createImageBitmap(png)
    const snapshot = { time, png, width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return snapshot
  } catch (error) {
    console.error('[native-chat] video frame capture failed', error)
    return null
  }
}

/** Clean frames of a video for its notes. Each frame is captured from the window once, with the
 *  marks hidden, before a mark is placed on it; Send draws every note on its own frame. */
export function useNativeChatVideoFrames({
  video,
  layer,
  notes
}: {
  video: React.RefObject<HTMLVideoElement | null>
  /** The element covering exactly the video's picture: the marks layer. */
  layer: React.RefObject<HTMLElement | null>
  notes: readonly NativeChatMediaNote[]
}): {
  /** True while a capture runs: the marks are hidden so they aren't in the frame. */
  capturing: boolean
  /** The frame at `time` is held, capturing it now if it isn't; false when that failed. */
  ensure: (time: number) => Promise<boolean>
  /** The held frames, for showing one as a still. */
  held: readonly NativeChatVideoSnapshot[]
  frame: NativeChatNotesFrameSource
} {
  const snapshots = useRef(new NativeChatVideoSnapshots())
  const [held, setHeld] = useState<readonly NativeChatVideoSnapshot[]>([])
  const [capturing, setCapturing] = useState(false)
  const generation = useRef(0)
  // The frames notes are on, which are always kept; current as of the last render.
  const usedTimes = useRef<readonly number[]>([])
  useEffect(() => {
    usedTimes.current = notes.flatMap((note) => (note.time === undefined ? [] : [note.time]))
    snapshots.current.prune(usedTimes.current)
    setHeld(snapshots.current.list())
  }, [notes])

  const capture = useCallback(
    async (time: number): Promise<NativeChatVideoSnapshot | null> => {
      const element = video.current
      const target = layer.current
      if (!element || !target) {
        return null
      }
      generation.current += 1
      const mine = generation.current
      setCapturing(true)
      const snapshot = await captureNativeChatVideoSnapshot(
        element,
        target,
        time,
        () => mine === generation.current
      )
      if (mine === generation.current) {
        setCapturing(false)
      }
      if (snapshot) {
        snapshots.current.add(snapshot, usedTimes.current)
        setHeld(snapshots.current.list())
      }
      return snapshot
    },
    [layer, video]
  )

  const ensure = useCallback(
    async (time: number): Promise<boolean> =>
      snapshots.current.find(time) !== undefined || (await capture(time)) !== null,
    [capture]
  )

  const frame = useCallback<NativeChatNotesFrameSource>(
    async (time) => {
      const at = time ?? 0
      let snapshot = snapshots.current.find(at)
      const element = video.current
      if (!snapshot && element) {
        // A note restored without its frame (reopened, or kept while the box held a command).
        if (!nativeChatVideoSeekable(element)) {
          throw new NativeChatVideoFrameUnavailable()
        }
        element.pause()
        await seekNativeChatVideo(element, at)
        snapshot = (await capture(at)) ?? undefined
      }
      if (!snapshot) {
        throw new Error('The video frame could not be captured')
      }
      const image = await createImageBitmap(snapshot.png)
      return { image, width: image.width, height: image.height, release: () => image.close() }
    },
    [capture, video]
  )

  return { capturing, ensure, held, frame }
}

/** The words of notes whose frame can't be attached any more, as plain text for the message. */
export function nativeChatVideoNotesAsText(
  mediaName: string,
  notes: readonly NativeChatMediaNote[]
): string {
  const lines = [...notes]
    .sort((a, b) => a.number - b.number)
    .map((note) => {
      const at = note.time === undefined ? '' : ` (at ${formatNativeChatNoteTime(note.time, true)})`
      return `${note.number}. ${note.text.trim().replace(/\r?\n/g, ' ')}${at}`
    })
  return [`Notes on ${mediaName} (its frames couldn't be attached):`, ...lines].join('\n')
}

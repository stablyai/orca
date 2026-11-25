import { useEffect, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import {
  formatNativeChatNoteTime,
  type NativeChatMediaNote,
  type NativeChatNoteMark
} from '../native-chat-media-notes'
import type { NativeChatMediaLoaded } from '../native-chat-notes-handoff'
import {
  nativeChatSameVideoFrame,
  nativeChatVideoContentRect,
  nativeChatVideoNoteTime,
  nativeChatVideoSeekable,
  seekNativeChatVideo,
  type NativeChatVideoRect
} from './native-chat-video-frames'
import { useNativeChatVideoFrames } from './use-native-chat-video-frames'
import { NativeChatMediaMarks } from '../NativeChatMediaMarks'
import { NativeChatVideoStill } from './NativeChatVideoStill'

const SPEEDS: readonly number[] = [1, 1.5, 2, 0.5]

/** A video in the notes viewer: controls under the frame, and marks only on the frame they're on.
 *  Annotating pauses it; a mark waits for its frame to be captured clean. */
export function NativeChatVideoStage({
  src,
  title,
  annotating,
  notes,
  focusTime,
  marks,
  onLoaded,
  onBroken,
  broken,
  fallback,
  placeRef,
  place,
  onCaptureFailed
}: {
  src: string | null
  title: string
  annotating: boolean
  /** Every note and the one being written. */
  notes: readonly NativeChatMediaNote[]
  /** The time of the note being edited: the video moves there. */
  focusTime: number | undefined
  /** The marks' own props; the stage picks which notes are on the frame shown. */
  marks: Omit<React.ComponentProps<typeof NativeChatMediaMarks>, 'notes' | 'onPlace'>
  onLoaded: (loaded: NativeChatMediaLoaded) => void
  onBroken: () => void
  broken: boolean
  fallback?: React.ReactNode
  /** Set to this stage's placing, for the viewport's Enter. */
  placeRef: React.RefObject<((mark: NativeChatNoteMark) => void) | null>
  place: (mark: NativeChatNoteMark, time: number) => void
  onCaptureFailed: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const layerRef = useRef<HTMLDivElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [content, setContent] = useState<NativeChatVideoRect | null>(null)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<number>(1)
  const frames = useNativeChatVideoFrames({ video: videoRef, layer: layerRef, notes })
  const [seekable, setSeekable] = useState(false)

  // The picture's box inside the element, kept as the element resizes; measured once the video is in.
  useEffect(() => {
    const box = boxRef.current
    const video = videoRef.current
    if (!box || !video) {
      return
    }
    const measure = (): void =>
      setContent(
        nativeChatVideoContentRect(
          { width: box.clientWidth, height: box.clientHeight },
          { width: video.videoWidth, height: video.videoHeight }
        )
      )
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    video.addEventListener('loadedmetadata', measure)
    return () => {
      observer.disconnect()
      video.removeEventListener('loadedmetadata', measure)
    }
  }, [src, broken])

  // Annotating works on a still frame.
  useEffect(() => {
    if (annotating) {
      videoRef.current?.pause()
    }
  }, [annotating])

  // Opening a note on another frame moves the video there.
  useEffect(() => {
    const video = videoRef.current
    if (
      focusTime === undefined ||
      !video ||
      !nativeChatVideoSeekable(video) ||
      nativeChatSameVideoFrame(video.currentTime, focusTime)
    ) {
      return
    }
    video.pause()
    void seekNativeChatVideo(video, focusTime)
  }, [focusTime])
  // A video that can't move shows that note's frame as its captured still instead.
  const still =
    focusTime !== undefined && !seekable && !nativeChatSameVideoFrame(time, focusTime)
      ? focusTime
      : null

  const placeHere = async (mark: NativeChatNoteMark): Promise<void> => {
    const video = videoRef.current
    if (!video || still !== null) {
      return
    }
    video.pause()
    const at = nativeChatVideoNoteTime(video.currentTime)
    if (await frames.ensure(at)) {
      place(mark, at)
    } else {
      onCaptureFailed()
    }
  }
  useEffect(() => {
    placeRef.current = (mark) => void placeHere(mark)
    return () => {
      placeRef.current = null
    }
  })

  const shownTime = still ?? time
  const stillSnapshot =
    still === null
      ? undefined
      : frames.held.find((frame) => nativeChatSameVideoFrame(frame.time, still))
  return (
    <div className="flex size-full flex-col gap-2">
      <div ref={boxRef} className="relative min-h-0 flex-1">
        {src && !broken ? (
          <video
            ref={videoRef}
            src={src}
            preload="metadata"
            playsInline
            aria-label={title}
            className="pointer-events-none size-full object-contain"
            onLoadedMetadata={(event) => {
              const video = event.currentTarget
              setDuration(Number.isFinite(video.duration) ? video.duration : 0)
              setSeekable(nativeChatVideoSeekable(video))
              onLoaded({
                kind: 'video',
                size: { width: video.videoWidth, height: video.videoHeight },
                frame: frames.frame
              })
            }}
            onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
            onSeeked={(event) => setTime(event.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onError={onBroken}
          />
        ) : (
          <div className="flex size-full items-center justify-center">{fallback}</div>
        )}
        {content && content.width > 0 ? (
          <div
            ref={layerRef}
            className="absolute"
            style={{
              left: content.x,
              top: content.y,
              width: content.width,
              height: content.height
            }}
          >
            {stillSnapshot ? <NativeChatVideoStill snapshot={stillSnapshot} /> : null}
            {frames.capturing ? null : (
              <NativeChatMediaMarks
                {...marks}
                notes={notes.filter((note) => nativeChatSameVideoFrame(note.time, shownTime))}
                pending={
                  marks.pending && nativeChatSameVideoFrame(marks.pending.time, shownTime)
                    ? marks.pending
                    : null
                }
                onPlace={(mark) => void placeHere(mark)}
              />
            )}
          </div>
        ) : null}
        {still !== null && !stillSnapshot ? (
          <div className="absolute inset-x-0 top-2 text-center text-xs text-media-canvas-foreground">
            {t('components.native-chat.notes.cantSeek', 'Can’t seek this video')}
          </div>
        ) : null}
      </div>
      {src && !broken ? (
        <div className="flex shrink-0 items-center gap-2 rounded-md bg-media-paper px-2 py-1 text-media-paper-foreground">
          <Button
            type="button"
            variant="media-paper-ghost"
            size="icon-xs"
            aria-label={
              playing
                ? t('components.native-chat.notes.pause', 'Pause')
                : t('components.native-chat.notes.play', 'Play')
            }
            onClick={() => {
              const video = videoRef.current
              if (video) {
                void (video.paused ? video.play() : Promise.resolve(video.pause()))
              }
            }}
          >
            {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          </Button>
          <span className="shrink-0 text-xs tabular-nums">
            {formatNativeChatNoteTime(shownTime, false)}
            {duration > 0 ? ` / ${formatNativeChatNoteTime(duration, false)}` : ''}
          </span>
          <input
            type="range"
            aria-label={t('components.native-chat.notes.seek', 'Position')}
            min={0}
            max={duration || 0}
            step={0.01}
            value={Math.min(shownTime, duration || 0)}
            disabled={!seekable}
            onChange={(event) => {
              const video = videoRef.current
              if (video) {
                video.currentTime = Number(event.currentTarget.value)
              }
            }}
            className="min-w-0 flex-1 accent-media-note"
          />
          <Button
            type="button"
            variant="media-paper-ghost"
            size="xs"
            aria-label={t('components.native-chat.notes.speed', 'Playback speed {{speed}}×', {
              speed
            })}
            onClick={() => {
              const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!
              setSpeed(next)
              if (videoRef.current) {
                videoRef.current.playbackRate = next
              }
            }}
          >
            {speed}×
          </Button>
        </div>
      ) : null}
    </div>
  )
}

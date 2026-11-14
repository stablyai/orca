import {
  CLOUD_DICTATION_MAX_SECONDS,
  DICTATION_SAMPLE_RATE
} from '../../../../shared/rpc-contract/speech/speech-params'
import type { DictationContext } from '../../../../shared/speech-types'
import type { DictationInsertionTarget } from './dictation-insertion-target'
import type { DictationTranscriptDelivery } from './dictation-transcript-delivery'
import { trimLandedOverlap } from './dictation-retry-overlap'
import { appendDictationText } from '../../../../shared/dictation-transcript-spacing'
import { showRetryOverlapUnmatchedToast } from './dictation-toasts'

// The cloud cap, ten minutes, is about 38 MB of 16 kHz float audio.
const MAX_KEPT_SAMPLES = CLOUD_DICTATION_MAX_SECONDS * DICTATION_SAMPLE_RATE

/** A session's audio, in memory only, so a failed transcription can be retried into the same place. */
export type DictationKeptRecording = {
  chunks: Float32Array[]
  /** False once audio past the cap was dropped; a retry would then lose words. */
  complete: boolean
  target: DictationInsertionTarget | null
  deliver: DictationTranscriptDelivery
  /** A retry spells with the dictionary of the place it started in. */
  context: DictationContext
}

export function createDictationKeptRecording(
  target: DictationInsertionTarget | null,
  deliver: DictationTranscriptDelivery,
  context: DictationContext
): DictationKeptRecording & {
  keep: (samples: Float32Array) => void
  /** The host stopped accepting audio at its own cap, so the first ten minutes are all it would hear. */
  reachedHostLimit: () => void
} {
  let samples = 0
  let hostLimited = false
  const chunks: Float32Array[] = []
  const recording = {
    chunks,
    complete: true,
    target,
    deliver,
    context,
    keep: (frame: Float32Array): void => {
      const room = MAX_KEPT_SAMPLES - samples
      if (room <= 0) {
        recording.complete = hostLimited
        return
      }
      const kept = frame.length > room ? frame.subarray(0, room) : frame
      samples += kept.length
      chunks.push(kept)
      if (kept !== frame) {
        recording.complete = hostLimited
      }
    },
    reachedHostLimit: (): void => {
      hostLimited = true
      recording.complete = true
    }
  }
  return recording
}

/** Whether a failure can offer Retry: some audio was kept, and all of it. */
export function canRetryDictation(recording: DictationKeptRecording | null): boolean {
  return recording !== null && recording.complete && recording.chunks.length > 0
}

// Ten-second blocks keep a retried recording to a few hundred feeds instead of one per 100 ms frame.
const RETRY_BLOCK_SAMPLES = 10 * DICTATION_SAMPLE_RATE

/** Built one block at a time, so a retry never holds a second copy of the whole recording. */
function* joinIntoBlocks(chunks: Float32Array[]): Generator<Float32Array> {
  let start = 0
  while (start < chunks.length) {
    let end = start
    let blockSamples = 0
    while (end < chunks.length && blockSamples < RETRY_BLOCK_SAMPLES) {
      blockSamples += chunks[end].length
      end += 1
    }
    const block = new Float32Array(blockSamples)
    let offset = 0
    for (let index = start; index < end; index += 1) {
      block.set(chunks[index], offset)
      offset += chunks[index].length
    }
    yield block
    start = end
  }
}

// The retry repeats words that landed before the failure; only what follows them is typed.
function insertAfterLanded(recording: DictationKeptRecording, retried: string[]): void {
  const { text, matched } = trimLandedOverlap(
    recording.deliver.landedText(),
    retried.reduce(appendDictationText, '')
  )
  if (text) {
    recording.deliver(text, recording.target)
  }
  if (!matched) {
    showRetryOverlapUnmatchedToast()
  }
}

/** Runs a kept recording through a new speech session; `finish` stops it and waits for its words. */
export async function transcribeKeptRecording(args: {
  recording: DictationKeptRecording
  modelId: string
  sessionId: string
  isCurrent: () => boolean
  /** Where the retry's finals go until it ends. */
  routeFinals: (sink: (text: string) => void) => void
  finish: (beforeEnd: () => void) => Promise<void>
  fail: (message: string) => void
}): Promise<void> {
  const { sessionId, isCurrent } = args
  const retried: string[] = []
  args.routeFinals((text) => retried.push(text))
  try {
    await window.api.speech.startDictation(args.modelId, args.recording.context, sessionId)
    for (const block of joinIntoBlocks(args.recording.chunks)) {
      if (!isCurrent()) {
        break
      }
      await window.api.speech.feedAudio(block, DICTATION_SAMPLE_RATE, sessionId)
    }
    if (!isCurrent()) {
      await window.api.speech.cancelDictation(sessionId).catch(() => undefined)
      return
    }
    await args.finish(() => insertAfterLanded(args.recording, retried))
  } catch (error) {
    if (!isCurrent()) {
      return
    }
    await window.api.speech.cancelDictation(sessionId).catch(() => undefined)
    if (isCurrent()) {
      args.fail(String(error))
    }
  }
}

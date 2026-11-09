import { DICTATION_SAMPLE_RATE } from '../../../../shared/rpc-contract/speech-params'
import type { DictationInsertionTarget } from './dictation-insertion-target'
import type { DictationTranscriptDelivery } from './dictation-transcript-delivery'

// Ten minutes, the cloud upload cap, is about 38 MB of 16 kHz float audio.
const MAX_KEPT_SAMPLES = 10 * 60 * DICTATION_SAMPLE_RATE

/** A session's audio, in memory only, so a failed transcription can be retried into the same place. */
export type DictationKeptRecording = {
  chunks: Float32Array[]
  /** False once the recording outgrew what we keep; a retry would then lose words. */
  complete: boolean
  target: DictationInsertionTarget | null
  deliver: DictationTranscriptDelivery
}

export function createDictationKeptRecording(
  target: DictationInsertionTarget | null,
  deliver: DictationTranscriptDelivery
): DictationKeptRecording & { keep: (samples: Float32Array) => void } {
  let samples = 0
  const chunks: Float32Array[] = []
  const recording = {
    chunks,
    complete: true,
    target,
    deliver,
    keep: (frame: Float32Array): void => {
      if (!recording.complete) {
        return
      }
      if (samples + frame.length > MAX_KEPT_SAMPLES) {
        recording.complete = false
        recording.chunks = []
        return
      }
      samples += frame.length
      recording.chunks.push(frame)
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

function joinIntoBlocks(chunks: Float32Array[]): Float32Array[] {
  const blocks: Float32Array[] = []
  let pending: Float32Array[] = []
  let pendingSamples = 0
  const flush = (): void => {
    const block = new Float32Array(pendingSamples)
    let offset = 0
    for (const chunk of pending) {
      block.set(chunk, offset)
      offset += chunk.length
    }
    blocks.push(block)
    pending = []
    pendingSamples = 0
  }
  for (const chunk of chunks) {
    pending.push(chunk)
    pendingSamples += chunk.length
    if (pendingSamples >= RETRY_BLOCK_SAMPLES) {
      flush()
    }
  }
  if (pendingSamples > 0) {
    flush()
  }
  return blocks
}

/** Runs a kept recording through a new speech session; `finish` stops it and waits for its words to land. */
export async function transcribeKeptRecording(args: {
  recording: DictationKeptRecording
  modelId: string
  sessionId: string
  isCurrent: () => boolean
  finish: () => Promise<void>
  fail: (message: string) => void
}): Promise<void> {
  const { sessionId, isCurrent } = args
  try {
    await window.api.speech.startDictation(args.modelId, undefined, sessionId)
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
    await args.finish()
  } catch (error) {
    if (!isCurrent()) {
      return
    }
    await window.api.speech.cancelDictation(sessionId).catch(() => undefined)
    args.fail(String(error))
  }
}

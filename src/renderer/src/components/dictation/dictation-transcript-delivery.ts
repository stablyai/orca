import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { describeClipboardWriteFailure } from '@/lib/clipboard/clipboard-write-failure'
import { appendDictationText } from '../../../../shared/dictation-transcript-spacing'
import { insertText, type DictationInsertionTarget } from './dictation-insertion-target'

export type DictationTranscriptDelivery = ((
  text: string,
  target: DictationInsertionTarget | null
) => void) & {
  /** Everything this session has typed into its target so far. */
  landedText: () => string
  /** Waits for every final so far to land; false if any went to the clipboard instead. */
  settled: () => Promise<boolean>
  /** What AI cleanup is holding back, or null when nothing is held. */
  held: () => string | null
  /** Stops holding: `text` (the cleaned words), else the held words as heard, lands once where they were going. */
  releaseHeld: (text?: string) => void
  /** Holds the finals that follow, as a retry of a failed session does while cleanup is on. */
  hold: () => void
}

/** One session's finals, inserted in order; text that can't land goes to the clipboard so it isn't lost. With `hold`, finals wait for AI cleanup and land together. */
export function createDictationTranscriptDelivery(hold = false): DictationTranscriptDelivery {
  let lastLanded = ''
  let allLanded = ''
  let missed = ''
  let queue = Promise.resolve()
  let holding = hold
  let held = ''
  let heldTarget: DictationInsertionTarget | null = null
  const insert = (text: string, target: DictationInsertionTarget | null): void => {
    queue = queue.then(async () => {
      const landed = target ? await insertText(text, target, lastLanded).catch(() => false) : false
      if (landed) {
        lastLanded = text
        allLanded = appendDictationText(allLanded, text)
        return
      }
      missed = appendDictationText(missed, text)
      await copyMissedDictation(missed, target !== null)
    })
  }
  const deliver = (text: string, target: DictationInsertionTarget | null): void => {
    if (!holding) {
      insert(text, target)
      return
    }
    held = appendDictationText(held, text)
    heldTarget = target
  }
  return Object.assign(deliver, {
    landedText: () => allLanded,
    settled: () => queue.then(() => missed === ''),
    held: () => (holding && held ? held : null),
    hold: (): void => {
      holding = true
      held = ''
    },
    releaseHeld: (text = held): void => {
      if (!holding) {
        return
      }
      holding = false
      if (text) {
        insert(text, heldTarget)
      }
    }
  })
}

async function copyMissedDictation(text: string, hadTarget: boolean): Promise<void> {
  // One toast per session's missed text, updated as more arrives.
  const id = 'dictation-missed-text'
  try {
    await window.api.ui.writeClipboardText(text)
  } catch (error) {
    toast.error(
      translate(
        'auto.components.dictation.dictation-transcript-delivery.lost',
        "Dictation couldn't be inserted or copied."
      ),
      { id, description: describeClipboardWriteFailure(error) }
    )
    return
  }
  toast.message(
    hadTarget
      ? translate(
          'auto.components.dictation.dictation-transcript-delivery.copiedAfterFailedInsert',
          "Dictation couldn't be inserted, so it was copied to the clipboard."
        )
      : translate(
          'auto.components.dictation.dictation-transcript-delivery.copiedWithoutTarget',
          'No text field was focused, so dictation was copied to the clipboard.'
        ),
    { id }
  )
}

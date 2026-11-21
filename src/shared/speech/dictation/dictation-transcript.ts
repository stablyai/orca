import { appendDictationText } from './dictation-transcript-spacing'

/** The text so far mid-dictation, for the desktop pill and phone replies: committed text never changes, tentative text may still be revised. */
export type DictationTranscriptSnapshot = {
  /** Grows with every change, so a client keeps the newest snapshot when replies arrive out of order. */
  revision: number
  committed: string
  tentative: string
  /** committed and tentative together, for clients that predate the split. */
  text: string
}

/** One dictation's speech events folded into the snapshot its chunk replies report. */
export class DictationTranscript {
  private committed = ''
  private tentative = ''
  private revisionCount = 0

  get revision(): number {
    return this.revisionCount
  }

  accept(event: { type: string; text?: string }): void {
    if (event.type === 'partial') {
      this.tentative = event.text ?? ''
      this.revisionCount += 1
    } else if (event.type === 'final') {
      const text = event.text?.trim()
      if (text) {
        this.committed = appendDictationText(this.committed, text)
        this.tentative = ''
        this.revisionCount += 1
      }
    }
  }

  snapshot(): DictationTranscriptSnapshot {
    return {
      revision: this.revisionCount,
      committed: this.committed,
      tentative: this.tentative,
      text: appendDictationText(this.committed, this.tentative.trim())
    }
  }
}

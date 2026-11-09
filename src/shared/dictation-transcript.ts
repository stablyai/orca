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
  private readonly committed: string[] = []
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
        this.committed.push(text)
        this.tentative = ''
        this.revisionCount += 1
      }
    }
  }

  snapshot(): DictationTranscriptSnapshot {
    const committed = this.committed.join(' ')
    return {
      revision: this.revisionCount,
      committed,
      tentative: this.tentative,
      text: [committed, this.tentative].join(' ').trim()
    }
  }
}

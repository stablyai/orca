export type EditorWordCount = { count: number; selected: boolean }

export type WordCountSource = {
  getDocumentVersion: () => unknown
  getDocumentLength: () => number
  getDocumentText: () => string
  getSelectedText: () => string[]
}

// Recounts run on the UI thread after every edit; larger documents hide the count instead.
const WORD_COUNT_MAX_DOCUMENT_LENGTH = 1_000_000

// Segmenter words keep CJK text, which has no spaces, from counting as one word per sentence.
const wordSegmenter = new Intl.Segmenter('und', { granularity: 'word' })

export function countWords(text: string): number {
  let count = 0
  for (const segment of wordSegmenter.segment(text)) {
    if (segment.isWordLike) {
      count++
    }
  }
  return count
}

export function createEditorWordCounter(source: WordCountSource): () => EditorWordCount | null {
  let cachedVersion: unknown
  let documentCount = 0
  let hasDocumentCount = false
  return () => {
    if (source.getDocumentLength() > WORD_COUNT_MAX_DOCUMENT_LENGTH) {
      return null
    }
    const selection = source.getSelectedText()
    if (selection.length > 0) {
      return { count: selection.reduce((sum, text) => sum + countWords(text), 0), selected: true }
    }
    const version = source.getDocumentVersion()
    if (!hasDocumentCount || cachedVersion !== version) {
      documentCount = countWords(source.getDocumentText())
      cachedVersion = version
      hasDocumentCount = true
    }
    return { count: documentCount, selected: false }
  }
}

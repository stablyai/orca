import { describe, expect, it } from 'vitest'
import { createDictationDictionary } from './dictation-dictionary'

const spell = (terms: Parameters<typeof createDictationDictionary>[0], text: string): string =>
  createDictationDictionary(terms)!(text)

describe('createDictationDictionary', () => {
  // Parakeet v3's real output for the dev bench's code-term clips.
  it('joins the words a model splits a code term into back into the term', () => {
    const terms = [
      { term: 'useAudioCapture' },
      { term: 'usePcmWorklet' },
      { term: 'stt-worker.ts' },
      { term: 'numThreads' },
      { term: 'useMemo' },
      { term: 'onChange' }
    ]
    expect(
      spell(terms, 'Rename use audio capture to use PCM worklet in the dictation controller.')
    ).toBe('Rename useAudioCapture to usePcmWorklet in the dictation controller.')
    expect(spell(terms, 'Open stt worker TS and set num threads to 4.')).toBe(
      'Open stt-worker.ts and set numThreads to 4.'
    )
    expect(spell(terms, 'Wrap it in use memo and pass the on-change call back.')).toBe(
      'Wrap it in useMemo and pass the onChange call back.'
    )
  })
})

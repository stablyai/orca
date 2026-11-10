import { describe, expect, it } from 'vitest'
import {
  createDictationDictionary,
  dictationTermsFor,
  dictationVocabulary
} from './dictation-dictionary'
import { createDictationTextPipeline } from './dictation-text-pipeline'

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

  it('replaces what the model hears instead, and fixes the spelling of the term itself', () => {
    const terms = [{ term: 'kubectl', heardAs: 'Quebecal' }, { term: 'Orca' }, { term: 'pnpm' }]
    expect(spell(terms, 'Use Quebecal to scale it.')).toBe('Use kubectl to scale it.')
    expect(spell(terms, "Open or ca's settings and run PNPM.")).toBe(
      "Open Orca's settings and run pnpm."
    )
  })

  it('keeps a term with symbols whole when the model already wrote it', () => {
    const terms = [{ term: 'C#' }, { term: '.NET' }]
    expect(spell(terms, 'Port the C# app to .NET, not plan C.')).toBe(
      'Port the C# app to .NET, not plan C.'
    )
  })

  it('leaves longer words and words split by a sentence end alone', () => {
    const terms = [{ term: 'React' }, { term: 'onChange' }]
    expect(spell(terms, 'Reactive state. Turn it on. Change it.')).toBe(
      'Reactive state. Turn it on. Change it.'
    )
  })

  it('replaces a "heard as" inside text written without spaces', () => {
    expect(spell([{ term: '光輝', heardAs: 'こうき' }], 'こうきさんに送って')).toBe(
      '光輝さんに送って'
    )
  })

  it('lets the repo name join its spoken words but never recase a single word', () => {
    const oneWord = dictationTermsFor({}, { displayName: 'orca' })
    const words = dictationTermsFor({}, { displayName: 'dd-scratch-repo' })

    expect(createDictationDictionary(oneWord)).toBeNull()
    expect(dictationVocabulary(oneWord)).toEqual(['orca'])
    expect(spell(words, 'Open dd scratch repo now.')).toBe('Open dd-scratch-repo now.')
    expect(dictationTermsFor({ dictationRepoNameHint: false }, { displayName: 'orca' })).toEqual([])
  })

  it("prefers a repo's spelling over a personal one", () => {
    const terms = dictationTermsFor(
      { dictationTerms: [{ term: 'rpc' }] },
      { dictationTerms: [{ term: 'RPC' }] }
    )
    expect(spell(terms, 'Call the rpc.')).toBe('Call the RPC.')
  })
})

describe('createDictationTextPipeline with terms', () => {
  it('spells a lowercase term after a sentence-start filler goes', () => {
    const clean = createDictationTextPipeline({ language: 'en' }, {}, [{ term: 'pnpm' }])!
    expect(clean('Um, pnpm test.')).toBe('pnpm test.')
  })
})

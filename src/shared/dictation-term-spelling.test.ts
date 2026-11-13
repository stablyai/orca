import { describe, expect, it } from 'vitest'
import { createDictationDictionary } from './dictation-term-spelling'

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

  // Parakeet v3 and Whisper large-v3 turbo's real output for `say` clips of the terms.
  it('spells a misheard word as the term when it sounds the same and is spelled close', async () => {
    const clean = createDictationDictionary([
      { term: 'Supabase' },
      { term: 'Vercel' },
      { term: 'oxlint' },
      { term: 'Silero' }
    ])!
    await expect
      .poll(() => clean('We moved the auth tables from Superbase to Postgres last week.'), {
        timeout: 5000
      })
      .toBe('We moved the auth tables from Supabase to Postgres last week.')
    expect(clean('Deploy the preview to Versal before the review.')).toBe(
      'Deploy the preview to Vercel before the review.'
    )
    expect(clean('Run auxlint on the changed files before you push.')).toBe(
      'Run oxlint on the changed files before you push.'
    )
    expect(clean('Parakeet and Celero both run inside the speech child.')).toBe(
      'Parakeet and Silero both run inside the speech child.'
    )
    expect(clean("It doesn't work on Versal.")).toBe("It doesn't work on Vercel.")
  })

  it('leaves ordinary words, names, runs of words and other languages alone', async () => {
    const clean = createDictationDictionary([
      { term: 'Bazel' },
      { term: 'Jupyter' },
      { term: 'Istio' },
      { term: 'Saleor' },
      { term: 'Vercel' }
    ])!
    await expect
      .poll(() => clean('Deploy the preview to Versal before the review.'), { timeout: 5000 })
      .toBe('Deploy the preview to Vercel before the review.')
    for (const text of [
      'The vessel reached the harbor just after noon.',
      'The phone has a thin bezel.',
      'The planet Jupiter is bright tonight.',
      'It is too late to call him now.',
      'The ship was a very fast sailer.',
      'Despliega la vista previa en Versal antes de la revisión.'
    ]) {
      expect(clean(text)).toBe(text)
    }
    // A bilingual model's Chinese sentence is not English, even though English is one of its languages.
    const bilingual = createDictationDictionary([{ term: 'Vercel' }], ['zh', 'en'])!
    expect(bilingual('请在 Versal 上部署预览。')).toBe('请在 Versal 上部署预览。')
    expect(bilingual('Deploy the preview to Versal before the review.')).toBe(
      'Deploy the preview to Vercel before the review.'
    )
  })
})

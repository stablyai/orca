import { describe, expect, it } from 'vitest'
import type { Translate } from '@/i18n/use-translate'
import { browserAnnotatePaletteHint } from './browser-annotate-palette-hint'

// The English defaults stand in for the translation.
const t: Translate = (_key, fallback) => fallback ?? ''

describe("the palette's hint in Draw", () => {
  it('says the page is still loading while Draw waits for it, and nothing once drawing', () => {
    const base = {
      t,
      activeTool: 'draw' as const,
      grab: { state: 'idle' as const, error: null },
      grabIntent: 'copy' as const,
      hasPendingAnnotation: false,
      browserAnnotationsLength: 0
    }
    expect(browserAnnotatePaletteHint({ ...base, drawWaitingForPage: true }).text).toBe(
      'Waiting for page…'
    )
    expect(browserAnnotatePaletteHint(base).text).toBe('')
  })
})

// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { resolveTabAgentFromSignals } from './use-tab-agent'

describe('resolveTabAgentFromSignals — Qoder vs Gemini title disambiguation', () => {
  it('prefers qodercli process identity over a Gemini-style OSC title', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '◇ Ready',
        hookAgent: null,
        processAgent: 'qoder',
        launchAgent: undefined
      })
    ).toBe('qoder')
  })

  it('resolves qoder from title when Gemini-style glyphs include a qodercli marker', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: '◇ qodercli',
        hookAgent: null,
        launchAgent: undefined
      })
    ).toBe('qoder')
  })

  it('resolves qoder over Gemini working glyph when title contains qodercli marker', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: '✦ qodercli working on task',
        hookAgent: null,
        launchAgent: undefined
      })
    ).toBe('qoder')
  })

  it('keeps bare Gemini OSC glyph titles on Gemini when no qodercli marker is present', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: '◇ Ready',
        hookAgent: null,
        launchAgent: undefined
      })
    ).toBe('gemini')
  })
})

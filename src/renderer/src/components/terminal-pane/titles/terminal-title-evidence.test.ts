import { describe, expect, it } from 'vitest'
import { resolvePaneTitleDecision } from './terminal-title-evidence'

describe('resolvePaneTitleDecision', () => {
  it.each([
    ['✦ Gemini CLI', '⠋ fix the gemini launcher', '⠋ fix the gemini launcher'],
    ['◇ Gemini CLI', '⠋ add ✦ icon to header', '⠋ add ✦ icon to header'],
    [
      '✋ Gemini CLI',
      '⠋ Codex: fix Gemini terminal behavior',
      '⠋ Codex: fix Gemini terminal behavior'
    ],
    ['✦ Gemini CLI', '✦ Analyze Codex', '✦ Gemini CLI'],
    ['✦ Qoder CLI', '✦ session | Thinking - grok', '✦ session | Thinking - grok'],
    ['▲ Qoder CLI', '▲ session | Action Required - grok', '▲ session | Action Required - grok'],
    ['◇ Qoder CLI CN', '◇ Qoder CLI CN | Idle - grok', '◇ Qoder CLI CN | Idle - grok'],
    ['✦ Qoder CLI CN', '✦ Qoder CLI CN (Codex | Claude Code)', '✦ Qoder CLI CN'],
    ['⠋ Grok', '* | Grok', '* | Grok'],
    ['⠋ Grok', '⠋ Codex: fix parser - grok', '⠋ Codex: fix parser - grok'],
    ['⠋ Grok', '⠋ - Codex: fix parser - grok', '⠋ Grok'],
    // Normalized-only history cannot recover the original task; title-only reuse remains supported.
    ['✦ Gemini CLI', '✦ Gemini CLI', '✦ Gemini CLI']
  ])('corrects only disproved old stamps (%s, %s)', (normalizedTitle, rawTitle, displayTitle) => {
    const decision = resolvePaneTitleDecision({
      normalizedTitle,
      rawTitle,
      displayOwnerAgentType: 'claude',
      rendererOwnerAgentType: null,
      userGpuMode: 'auto'
    })
    expect(decision.displayTitle).toBe(displayTitle)
    expect(decision.rawTitle).toBe(rawTitle)
  })

  it('derives the display label and the renderer veto from a pane-scoped OMP owner', () => {
    const decision = resolvePaneTitleDecision({
      normalizedTitle: 'Pi ready',
      rawTitle: '✦ Gemini CLI',
      displayOwnerAgentType: 'omp',
      rendererOwnerAgentType: 'omp',
      userGpuMode: 'auto'
    })
    expect(decision.displayTitle).toBe('OMP ready')
    expect(decision.rawTitle).toBe('✦ Gemini CLI')
    // Why: the OMP owner renames the label and vetoes the Gemini glyph fallback.
    expect(decision.rendererPolicy.gpuEnabled).toBe(true)
  })

  it('uses the renderer owner, not the display owner, for the GPU veto', () => {
    const decision = resolvePaneTitleDecision({
      normalizedTitle: 'Pi ready',
      rawTitle: '✦ Gemini CLI',
      // Sticky ownership labels the tab, but only current pane ownership can veto Gemini’s DOM fallback.
      displayOwnerAgentType: 'omp',
      rendererOwnerAgentType: undefined,
      userGpuMode: 'auto'
    })
    expect(decision.displayTitle).toBe('OMP ready')
    expect(decision.rendererPolicy.gpuEnabled).toBe(false)
    expect(decision.rendererPolicy.reason).toBe('agent-compatibility')
  })
})

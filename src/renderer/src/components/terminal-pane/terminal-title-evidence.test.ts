import { describe, expect, it } from 'vitest'
import { resolvePaneTitleDecision } from './terminal-title-evidence'

describe('resolvePaneTitleDecision', () => {
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

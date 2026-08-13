import { describe, expect, it } from 'vitest'
import { resolvePaneDisplayTitle, resolvePaneTitleDecision } from './terminal-title-evidence'

describe('resolvePaneDisplayTitle', () => {
  it('normalizes a Pi-compatible title to the resolved OMP owner', () => {
    expect(resolvePaneDisplayTitle('Pi ready', 'omp')).toBe('OMP ready')
  })

  it('passes an unowned title through unchanged', () => {
    expect(resolvePaneDisplayTitle('bash', undefined)).toBe('bash')
  })
})

describe('resolvePaneTitleDecision', () => {
  it('derives the display label from the pane-scoped owner while preserving the raw title', () => {
    const decision = resolvePaneTitleDecision({
      normalizedTitle: 'Pi ready',
      rawTitle: '⠀ Pi ready',
      displayOwnerAgentType: 'omp',
      userGpuMode: 'auto'
    })
    expect(decision.displayTitle).toBe('OMP ready')
    expect(decision.rawTitle).toBe('⠀ Pi ready')
    expect(decision.rendererPolicy.gpuEnabled).toBe(true)
  })

  // Why: title text is display-only evidence; it must never reach the GPU gate.
  it('keeps the renderer policy independent of the title and its owner', () => {
    const decision = resolvePaneTitleDecision({
      normalizedTitle: 'bash',
      rawTitle: 'bash',
      displayOwnerAgentType: undefined,
      userGpuMode: 'auto',
      inContextLossContainment: true
    })
    expect(decision.displayTitle).toBe('bash')
    expect(decision.rendererPolicy.gpuEnabled).toBe(false)
    expect(decision.rendererPolicy.reason).toBe('context-loss')
  })
})

import { describe, expect, it } from 'vitest'
import type { BaseDisableImpact } from '../../../../shared/agent-reference-snapshot'
import type { CustomTuiAgentId } from '../../../../shared/types'
import { buildLocalCatalogSnapshot, buildReadyCustom } from './agent-catalog-snapshot.fixture'
import { baseDisableNeedsConfirmation, countEnabledDerivatives } from './base-disable-plan'

const NONE: BaseDisableImpact = {
  savedReferences: { count: 0, atLeast: false },
  resumableSessions: { count: 0, atLeast: false }
}

describe('countEnabledDerivatives', () => {
  it('counts enabled ready customs on the base and ignores other bases', () => {
    const snapshot = buildLocalCatalogSnapshot({
      customAgents: [
        buildReadyCustom({ id: 'custom-agent:codex:a' as CustomTuiAgentId, base: 'codex' }),
        buildReadyCustom({ id: 'custom-agent:codex:b' as CustomTuiAgentId, base: 'codex' }),
        buildReadyCustom({ id: 'custom-agent:claude:c' as CustomTuiAgentId, base: 'claude' })
      ]
    })
    expect(countEnabledDerivatives(snapshot, 'codex')).toBe(2)
    expect(countEnabledDerivatives(snapshot, 'claude')).toBe(1)
  })

  it('excludes derivatives that are themselves disabled', () => {
    const id = 'custom-agent:codex:a' as CustomTuiAgentId
    const snapshot = buildLocalCatalogSnapshot({
      customAgents: [buildReadyCustom({ id, base: 'codex' })],
      disabledAgents: [id]
    })
    expect(countEnabledDerivatives(snapshot, 'codex')).toBe(0)
  })
})

describe('baseDisableNeedsConfirmation', () => {
  it('is immediate when nothing is affected', () => {
    expect(baseDisableNeedsConfirmation({ enabledDerivatives: 0, impact: NONE })).toBe(false)
  })

  it('confirms on any enabled derivative, saved reference, or resumable session', () => {
    expect(baseDisableNeedsConfirmation({ enabledDerivatives: 1, impact: NONE })).toBe(true)
    expect(
      baseDisableNeedsConfirmation({
        enabledDerivatives: 0,
        impact: {
          savedReferences: { count: 2, atLeast: false },
          resumableSessions: { count: 0, atLeast: false }
        }
      })
    ).toBe(true)
    expect(
      baseDisableNeedsConfirmation({
        enabledDerivatives: 0,
        impact: {
          savedReferences: { count: 0, atLeast: false },
          resumableSessions: { count: 1, atLeast: false }
        }
      })
    ).toBe(true)
  })

  it('confirms when an owner store is unreadable (cannot prove zero)', () => {
    expect(
      baseDisableNeedsConfirmation({
        enabledDerivatives: 0,
        impact: {
          savedReferences: { count: 0, atLeast: true },
          resumableSessions: { count: 0, atLeast: false }
        }
      })
    ).toBe(true)
  })
})

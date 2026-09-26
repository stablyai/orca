import { describe, expect, it } from 'vitest'
import type { RecoveryAgentBinding } from './cross-machine-recovery-descriptor'
import {
  projectV1RecoveryBindings,
  recoveryBindingKeyOf,
  recoveryBindingKeyString,
  selectRecoveryBinding
} from './cross-machine-recovery-binding-key'

function binding(overrides: Partial<RecoveryAgentBinding> = {}): RecoveryAgentBinding {
  return {
    sourcePaneKey: 'tab-1:leaf-1',
    sourceTabId: 'tab-1',
    sourceLeafId: 'leaf-1',
    surface: 'terminal',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    liveness: 'sleeping',
    state: 'working',
    launch: { sourceAgentArgs: null, sourceEnvKeys: [] },
    capturedAt: 1,
    updatedAt: 1,
    lastHumanInputAt: null,
    ...overrides
  }
}

const piA = binding({
  sourcePaneKey: 'tab-2:leaf-1',
  agent: 'pi',
  providerSession: { key: 'session_id', id: 'sess-1', transcriptPath: '/s/a.jsonl' }
})
const piB = binding({
  sourcePaneKey: 'tab-3:leaf-1',
  agent: 'pi',
  providerSession: { key: 'session_id', id: 'sess-1', transcriptPath: '/s/b.jsonl' }
})

describe('recovery binding keys', () => {
  it('keeps two pi sessions with one id and different transcripts distinct', () => {
    expect(recoveryBindingKeyString(recoveryBindingKeyOf(piA))).not.toBe(
      recoveryBindingKeyString(recoveryBindingKeyOf(piB))
    )
    expect(selectRecoveryBinding([piA, piB], recoveryBindingKeyOf(piB))).toEqual({
      ok: true,
      binding: piB
    })
  })

  it('ignores transcriptPath for agents that resume by id', () => {
    const claude = binding({
      providerSession: { key: 'session_id', id: 'sess-1', transcriptPath: '/s/c.jsonl' }
    })
    expect(recoveryBindingKeyString(recoveryBindingKeyOf(claude))).toBe(
      recoveryBindingKeyString({ agent: 'claude', key: 'session_id', id: 'sess-1' })
    )
  })

  it('accepts a bare id only when it names exactly one binding', () => {
    const claude = binding()
    const codex = binding({ sourcePaneKey: 'tab-4:leaf-1', agent: 'codex' })
    expect(selectRecoveryBinding([claude, codex], 'sess-1')).toEqual({
      ok: false,
      code: 'recovery_binding_ambiguous'
    })
    expect(selectRecoveryBinding([claude, codex], recoveryBindingKeyOf(codex))).toEqual({
      ok: true,
      binding: codex
    })
    expect(selectRecoveryBinding([claude], 'sess-1')).toEqual({ ok: true, binding: claude })
    expect(selectRecoveryBinding([claude], 'sess-9')).toEqual({
      ok: false,
      code: 'recovery_binding_not_found'
    })
  })
})

describe('projectV1RecoveryBindings', () => {
  it('dedupes by binding key with live winning, then exports only claude', () => {
    const sleeping = binding({ updatedAt: 9 })
    const live = binding({ sourcePaneKey: 'tab-5:leaf-1', liveness: 'live', updatedAt: 2 })
    const codex = binding({ sourcePaneKey: 'tab-4:leaf-1', agent: 'codex' })

    expect(projectV1RecoveryBindings([sleeping, live, codex, piA, piB])).toEqual({
      bindings: [live],
      omittedBindings: [
        { agent: 'codex', key: 'session_id', id: 'sess-1', reason: 'agent-not-supported-v1' },
        { agent: 'pi', key: 'session_id', id: 'sess-1', reason: 'agent-not-supported-v1' },
        { agent: 'pi', key: 'session_id', id: 'sess-1', reason: 'agent-not-supported-v1' }
      ]
    })
  })

  it('keeps the newest of two non-live bindings for one key', () => {
    const older = binding({ updatedAt: 1 })
    const newer = binding({ sourcePaneKey: 'tab-6:leaf-1', updatedAt: 5 })
    expect(projectV1RecoveryBindings([newer, older]).bindings).toEqual([newer])
  })
})

import { describe, expect, it } from 'vitest'
import type { AgentSessionOptionsResult } from '../protocol/agent-session-options-result'
import '../../../native-chat/input/session-options/native-chat-session-option-snapshot'
import {
  canSetStructuredAgentSessionOption,
  structuredAgentSessionOptionSnapshot
} from '../view/structured-agent-session-option-snapshot'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from '../structured-agent-session-options'
import '../view/structured-agent-session-option-view'
import { structuredAgentSessionSeedCatalog } from '../model-catalog/structured-agent-session-seed-catalog'

const permission = (state: Parameters<typeof structuredAgentSessionOptionSnapshot>[0]) =>
  structuredAgentSessionOptionSnapshot(state).find(
    (descriptor) => descriptor.id === 'permissionMode'
  )

function live(agent: string, current: AgentSessionOptionsResult['current'], autoMode?: boolean) {
  const seed = structuredAgentSessionSeedCatalog(agent)
  return applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState(agent, seed),
    seed,
    {
      models: [
        {
          id: 'model-a',
          label: 'Model A',
          isDefault: true,
          efforts: [],
          ...(autoMode === undefined ? {} : { supportsAutoMode: autoMode })
        }
      ],
      current: { model: 'model-a', ...current }
    }
  )
}

describe('the permission mode picker', () => {
  it('keeps the saved choice, including Own, independent of runtime reports', () => {
    const pr1 = live('codex', { permissionMode: 'ask' })
    expect(permission({ ...pr1, permissionOwnSupported: null })?.settable).toBe(false)
    expect(permission({ ...pr1, permissionOwnSupported: false })).toMatchObject({
      settable: true,
      kind: { currentValue: 'ask' }
    })
    const capable = { ...pr1, permissionOwnSupported: true, permissionMode: 'own' }
    for (const reportedPermissionMode of [undefined, null, 'full-access', 'read-only']) {
      const descriptor = permission({ ...capable, reportedPermissionMode })
      expect(descriptor).toMatchObject({
        settable: true,
        kind: {
          currentValue: 'own',
          choices: expect.not.arrayContaining([expect.objectContaining({ value: 'own' })])
        }
      })
    }
    // A resumed chat with no running agent shows its saved mode and can change it.
    expect(permission({ ...capable, permissionMode: 'full-access' })).toMatchObject({
      settable: true,
      valueSource: 'applied',
      kind: { currentValue: 'full-access' }
    })
    expect(
      permission({ ...capable, permissionMode: 'full-access', reportedPermissionMode: null })
    ).toMatchObject({ settable: true, kind: { currentValue: 'full-access' } })
  })

  it('admits supported Own delegation through the same descriptor/readiness predicate', () => {
    const state = { ...live('codex', { permissionMode: 'ask' }), permissionOwnSupported: true }
    expect(canSetStructuredAgentSessionOption(state, 'permissionMode', 'own')).toBe(true)
    for (const permissionOwnSupported of [false, null]) {
      const unsupported = { ...state, permissionOwnSupported }
      expect(canSetStructuredAgentSessionOption(unsupported, 'permissionMode', 'own')).toBe(false)
      expect(canSetStructuredAgentSessionOption(unsupported, 'permissionMode', 'full-access')).toBe(
        permissionOwnSupported === false
      )
    }
    expect(canSetStructuredAgentSessionOption(state, 'permissionMode', 'invalid')).toBe(false)
    expect(canSetStructuredAgentSessionOption(state, 'permissionMode', 'own', [], true)).toBe(false)
    expect(
      canSetStructuredAgentSessionOption(
        state,
        'permissionMode',
        'own',
        structuredAgentSessionOptionSnapshot(state),
        false
      )
    ).toBe(false)
    expect(
      canSetStructuredAgentSessionOption(state, 'permissionMode', 'own', undefined, true, true)
    ).toBe(false)
    expect(
      canSetStructuredAgentSessionOption(
        { ...state, reportedPermissionMode: null },
        'permissionMode',
        'own'
      )
    ).toBe(true)
  })
})

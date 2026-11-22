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
import { projectRuntimePermission } from './structured-agent-session-permission-option'
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

  it('passes the reported mode along only while the chat follows its agent settings', () => {
    const own = {
      ...live('claude', { permissionMode: 'ask' }),
      permissionOwnSupported: true,
      permissionMode: 'own'
    }
    for (const reportedPermissionMode of ['full-access', 'ask', 'plan']) {
      expect(permission({ ...own, reportedPermissionMode })?.kind).toMatchObject({
        currentValue: 'own',
        reportedValue: reportedPermissionMode
      })
    }
    for (const reportedPermissionMode of [undefined, null]) {
      expect(permission({ ...own, reportedPermissionMode })?.kind).not.toHaveProperty(
        'reportedValue'
      )
    }
    const explicit = permission({ ...own, permissionMode: 'ask', reportedPermissionMode: 'plan' })
    expect(explicit?.kind).toMatchObject({ currentValue: 'ask' })
    expect(explicit?.kind).not.toHaveProperty('reportedValue')
  })

  it('reads a null report as no report, since null carries no mode', () => {
    // A Codex reply without policy fields, a Claude clear and an ACP agent without a mode selector all report null.
    for (const agent of ['codex', 'claude', 'opencode']) {
      const own = {
        ...live(agent, { permissionMode: 'ask' }),
        permissionOwnSupported: true,
        permissionMode: 'own'
      }
      const cleared = permission({ ...own, reportedPermissionMode: null })
      expect(cleared?.kind).toMatchObject({ currentValue: 'own' })
      expect(cleared).toEqual(permission({ ...own, reportedPermissionMode: undefined }))
    }
  })

  it("shows a newer child's report and keeps the read report over an older one", () => {
    const own = {
      ...live('claude', { permissionMode: 'ask' }),
      permissionOwnSupported: true,
      permissionMode: 'own',
      reportedPermissionMode: 'ask'
    }
    const reported = (runtimePermission: unknown, fence: number) =>
      permission(projectRuntimePermission(own, { runtimePermission }, fence))?.kind
    // A new chat attaches at fence 1; its first child starts at fence 2.
    expect(reported({ fence: 2, mode: 'full-access' }, 1)).toMatchObject({
      reportedValue: 'full-access'
    })
    expect(reported({ fence: 1, mode: 'full-access' }, 2)).toMatchObject({ reportedValue: 'ask' })
    expect(reported(null, 1)).not.toHaveProperty('reportedValue')
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

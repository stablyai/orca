import { describe, expect, it } from 'vitest'
import type { AgentSessionOptionsResult } from './agent-session-wire'
import { sortNativeChatSessionOptions } from './native-chat/input/native-chat-session-option-snapshot'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionPicks,
  structuredAgentSessionOptionSnapshot
} from './structured-agent-session-options'
import { structuredAgentSessionOptionView } from './structured-agent-session-option-view'
import { structuredAgentSessionSeedCatalog } from './structured-agent-session-seed-catalog'

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
  it('shows the saved mode until a report, except for own, which waits for the report', () => {
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
        settable: typeof reportedPermissionMode === 'string',
        kind: {
          currentValue: reportedPermissionMode ?? undefined,
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
    ).toMatchObject({ settable: false, kind: { currentValue: undefined } })
  })

  it('shows the seeded mode before the agent starts, beside the quiet model pill', () => {
    const state = createStructuredAgentSessionOptionState(
      'codex',
      structuredAgentSessionSeedCatalog('codex')
    )
    const view = structuredAgentSessionOptionView(state, { permissionMode: 'full-access' }, {})
    expect(structuredAgentSessionOptionSnapshot(view).map((descriptor) => descriptor.id)).toEqual([
      'model',
      'permissionMode'
    ])
    expect(permission(view)).toMatchObject({
      settable: true,
      kind: { currentValue: 'full-access' }
    })
  })

  it("shows a held pick over the host's value, and the host's over the seed", () => {
    const state = live('codex', { permissionMode: 'auto' })
    const seed = { permissionMode: 'ask' }
    expect(permission(structuredAgentSessionOptionView(state, seed, {}))).toMatchObject({
      kind: { currentValue: 'auto' }
    })
    expect(
      permission(structuredAgentSessionOptionView(state, seed, { permissionMode: 'full-access' }))
    ).toMatchObject({ kind: { currentValue: 'full-access' } })
  })

  it('stays out of the per-model option pill and out of the saved selection', () => {
    const state = live('codex', { permissionMode: 'ask' })
    expect(
      sortNativeChatSessionOptions(structuredAgentSessionOptionSnapshot(state)).map(
        (descriptor) => descriptor.id
      )
    ).not.toContain('permissionMode')
    expect(structuredAgentSessionOptionPicks(state, { permissionMode: 'full-access' })).toEqual([])
  })
})

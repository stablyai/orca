import { describe, expect, it } from 'vitest'
import type { AgentSessionOptionsResult } from './agent-session-wire'
import { sortNativeChatSessionOptions } from './native-chat/input/native-chat-session-option-snapshot'
import {
  applyStructuredAgentSessionOptions,
  commitStructuredAgentSessionOption,
  commitStructuredAgentSessionOptionValues,
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
  it('keeps old-host fallback while capable hosts display only the nullable report', () => {
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
    expect(permission({ ...capable, permissionMode: 'ask' })?.settable).toBe(false)
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

  it('shows nothing for a host that states no mode, or an agent with none', () => {
    expect(permission(live('codex', {}))).toBeUndefined()
    expect(permission(live('pi', { permissionMode: 'ask' }))).toBeUndefined()
  })

  it("offers Codex's three modes with its own descriptions", () => {
    const descriptor = permission(live('codex', { permissionMode: 'ask' }))
    expect(descriptor?.kind.type === 'select' && descriptor.kind.choices).toEqual([
      {
        value: 'ask',
        label: 'Ask for approval',
        description: "Asks before edits or commands it isn't already allowed to make"
      },
      { value: 'auto', label: 'Approve for me', description: 'Reviews approval requests for you' },
      {
        value: 'full-access',
        label: 'Full access',
        description: 'Never asks; can edit any file and use the network'
      }
    ])
  })

  it('offers all Claude modes regardless of catalog support, and shows the host mode as stated', () => {
    const unsupported = permission(live('claude', { permissionMode: 'ask' }, false))
    expect(
      unsupported?.kind.type === 'select' && unsupported.kind.choices.map((c) => c.value)
    ).toEqual(['ask', 'accept-edits', 'auto', 'full-access'])
    expect(permission(live('claude', { permissionMode: 'auto' }, false))).toMatchObject({
      kind: { currentValue: 'auto' }
    })
    const state = createStructuredAgentSessionOptionState('claude')
    const descriptor = permission(
      structuredAgentSessionOptionView(state, { permissionMode: 'ask' }, {})
    )
    expect(
      descriptor?.kind.type === 'select' && descriptor.kind.choices.map((c) => c.value)
    ).toContain('auto')
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

  it('takes a settled pick, and the record a write answers with', () => {
    const state = live('codex', { permissionMode: 'ask' })
    expect(commitStructuredAgentSessionOption(state, 'permissionMode', 'auto').permissionMode).toBe(
      'auto'
    )
    expect(
      commitStructuredAgentSessionOptionValues(state, {
        model: 'model-a',
        permissionMode: 'full-access'
      }).permissionMode
    ).toBe('full-access')
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

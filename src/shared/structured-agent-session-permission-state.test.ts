import { describe, expect, it } from 'vitest'
import { CLAUDE_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-claude-codex'
import type { AgentSessionOptionsResult } from './agent-session-wire'
import { parseStructuredLaunchSeedOptions } from './native-chat-session-option-defaults'
import {
  applyStructuredAgentSessionOptions,
  canSetStructuredAgentSessionOption,
  commitStructuredAgentSessionOptionValues,
  createStructuredAgentSessionOptionState
} from './structured-agent-session-options'
import { structuredAgentSessionOptionView } from './structured-agent-session-option-view'
import { structuredAgentSessionOptionPicks } from './structured-agent-session-option-picks'

const MODELS: AgentSessionOptionsResult['models'] = [
  { id: 'sonnet', label: 'Sonnet', isDefault: true, efforts: [] },
  { id: 'opus', label: 'Opus', isDefault: false, efforts: [] }
]

function reported(permissionModes?: AgentSessionOptionsResult['permissionModes']) {
  return applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG),
    CLAUDE_SESSION_OPTION_CATALOG,
    {
      models: MODELS,
      current: { model: 'sonnet' },
      ...(permissionModes ? { permissionModes } : {})
    }
  )
}

describe('a structured chat permission mode on the client', () => {
  // The host's report is the capability: an older host omits it and the picker never shows.
  it('offers no picker on a host that predates it', () => {
    expect(reported().permission).toBeNull()
  })

  it('reads the host report', () => {
    expect(
      reported({ current: 'auto', supported: ['ask', 'accept-edits', 'auto', 'bypass'] }).permission
    ).toEqual({ current: 'auto', supported: ['ask', 'accept-edits', 'auto', 'bypass'] })
  })

  it('keeps the mode through a model switch, which never touches it', () => {
    const state = reported({ current: 'bypass', supported: ['ask', 'bypass'] })
    const switched = commitStructuredAgentSessionOptionValues(state, { model: 'opus' })
    expect(switched.permission?.current).toBe('bypass')
  })

  it('commits an accepted pick and never remembers it as a launch default', () => {
    const state = reported({ current: 'ask', supported: ['ask', 'accept-edits', 'bypass'] })
    const committed = { model: 'sonnet', permissionMode: 'accept-edits' }
    expect(commitStructuredAgentSessionOptionValues(state, committed).permission?.current).toBe(
      'accept-edits'
    )
    expect(
      structuredAgentSessionOptionPicks(state, committed).map((pick) => pick.optionId)
    ).not.toContain('permissionMode')
  })

  it('accepts a pick only from the reported list, and none while another write is pending', () => {
    const state = reported({ current: 'ask', supported: ['ask', 'bypass'] })
    expect(canSetStructuredAgentSessionOption(state, 'permissionMode', 'bypass')).toBe(true)
    expect(canSetStructuredAgentSessionOption(state, 'permissionMode', 'auto')).toBe(false)
    expect(
      canSetStructuredAgentSessionOption({ ...state, pendingId: 'model' }, 'permissionMode', 'ask')
    ).toBe(false)
    expect(canSetStructuredAgentSessionOption(reported(), 'permissionMode', 'ask')).toBe(false)
  })
})

describe('a new chat permission mode before its session exists', () => {
  const fresh = () =>
    createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG)

  // The create seed naming a mode is the host saying it offers the picker; the setting picks it.
  it('shows the mode the host will create the chat in', () => {
    expect(
      structuredAgentSessionOptionView(fresh(), { permissionMode: 'bypass' }, {}).permission
    ).toEqual({ current: 'bypass', supported: ['ask', 'accept-edits', 'auto', 'bypass'] })
  })

  it('shows a pick held for the launch over the seed', () => {
    const view = structuredAgentSessionOptionView(
      fresh(),
      { model: 'sonnet', permissionMode: 'bypass' },
      { permissionMode: 'ask' }
    )
    expect(view.permission?.current).toBe('ask')
  })

  it('lets the host report replace the seed once it has one', () => {
    const state = reported({ current: 'accept-edits', supported: ['ask', 'accept-edits'] })
    expect(
      structuredAgentSessionOptionView(state, { permissionMode: 'bypass' }, {}).permission
    ).toEqual({ current: 'accept-edits', supported: ['ask', 'accept-edits'] })
  })

  it('offers nothing from a seed of an older host, which carries no mode', () => {
    expect(structuredAgentSessionOptionView(fresh(), { model: 'sonnet' }, {}).permission).toBeNull()
  })

  it('keeps a seeded mode only when this build can name it', () => {
    expect(parseStructuredLaunchSeedOptions({ model: 'sonnet', permissionMode: 'bypass' })).toEqual(
      { model: 'sonnet', permissionMode: 'bypass' }
    )
    expect(parseStructuredLaunchSeedOptions({ model: 'sonnet', permissionMode: 'plan' })).toEqual({
      model: 'sonnet'
    })
  })
})

it.each(['claude', 'codex'])(
  'offers provisional Auto for %s and retains it through launch',
  (agent) => {
    const state = createStructuredAgentSessionOptionState(agent)
    const view = structuredAgentSessionOptionView(
      state,
      { permissionMode: 'ask' },
      { permissionMode: 'auto' }
    )
    expect(view.permission?.current).toBe('auto')
    expect(view.permission?.supported).toContain('auto')
    expect(canSetStructuredAgentSessionOption(view, 'permissionMode', 'auto')).toBe(true)
    expect(
      structuredAgentSessionOptionView(state, { permissionMode: 'auto' }, {}).permission?.current
    ).toBe('auto')
  }
)

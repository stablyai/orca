import { expect, it, vi } from 'vitest'
import {
  openStructuredAgentSession,
  type StructuredSessionOpenDeps,
  type StructuredSessionOpenSource,
  type StructuredSessionOpenTab
} from './open-structured-agent-session'
import { structuredSessionIdFromNotificationPane } from './structured-session-notification-pane'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from './agent-session/view/structured-agent-session-projection'

const target = { sessionId: 'current', worktreeId: 'owner', agent: 'codex' }
const row = { id: 'actual-issued-id', sessionId: 'current', agent: 'codex' }
const sources: StructuredSessionOpenSource[] = [
  {
    kind: 'history',
    structuredSession: { sessionId: 'historical', workspaceId: 'old' },
    agent: 'codex'
  },
  { kind: 'notification', sessionId: 'historical', worktreeId: 'old' },
  {
    kind: 'sender',
    party: { address: 'dispatch:worker', terminalHandle: null, orcaSessionId: null },
    messageIds: ['mail-1']
  }
]
function rig() {
  let rows: StructuredSessionOpenTab[] = []
  const events: string[] = []
  const deps: StructuredSessionOpenDeps = {
    locate: vi.fn(async () => ({ location: { kind: 'chat' as const, ...target } })),
    tabs: () => rows,
    refresh: vi.fn(async () => {
      events.push('refresh')
    }),
    activate: vi.fn(async () => {
      events.push('activate')
      return true
    }),
    reveal: vi.fn(async () => {
      events.push('reveal')
      rows = [row]
      return target
    })
  }
  return {
    deps,
    events,
    rows: (value: StructuredSessionOpenTab[]) => {
      rows = value
    }
  }
}
it.each(sources)(
  'resolves lineage and selects the actual returned row for $kind',
  async (source) => {
    const { deps, events } = rig()
    expect(await openStructuredAgentSession(source, deps)).toMatchObject({
      kind: 'opened',
      target,
      tab: row
    })
    expect(events).toEqual(
      source.kind === 'history'
        ? ['refresh', 'refresh', 'reveal', 'refresh', 'activate']
        : ['refresh', 'reveal', 'refresh', 'activate']
    )
    expect(deps.activate).toHaveBeenCalledWith(row, target)
    expect(deps.locate).toHaveBeenCalledWith(
      source.kind === 'sender' ? source.party.address : 'orca_session_id:historical',
      source.kind === 'sender' ? ['mail-1'] : []
    )
  }
)
it('selects an existing chat without reveal and treats refresh as advisory', async () => {
  const r = rig()
  r.rows([row])
  expect(
    await openStructuredAgentSession(
      { kind: 'history', structuredSession: { sessionId: 'current', workspaceId: 'owner' } },
      r.deps
    )
  ).toMatchObject({ kind: 'opened' })
  expect(r.events).toEqual(['activate'])
  r.rows([])
  r.deps.refresh = vi.fn(async () => {
    throw new Error('inventory unavailable')
  })
  expect(await openStructuredAgentSession(sources[0]!, r.deps)).toMatchObject({ kind: 'opened' })
})
it('keeps unknown separate from proven gone and does not reveal either', async () => {
  for (const lost of [undefined, 'chat'] as const) {
    const { deps } = rig()
    deps.locate = async () => ({ location: null, ...(lost ? { lost } : {}) })
    expect(await openStructuredAgentSession(sources[0]!, deps)).toMatchObject({
      kind: 'failed',
      failure: { reason: lost ? 'gone' : 'unknown' }
    })
    expect(deps.reveal).not.toHaveBeenCalled()
  }
})
it('uses old-host identity only after explicit unsupported lookup, never after an ambiguous answer', async () => {
  const { deps } = rig()
  deps.locate = async () => {
    throw { code: 'method_not_found' }
  }
  deps.reveal = async () => ({ reason: 'unsupported', beforeEffects: true })
  expect(await openStructuredAgentSession(sources[0]!, deps)).toMatchObject({
    kind: 'failed',
    failure: { reason: 'unsupported', beforeEffects: true }
  })
  deps.locate = async () => {
    throw new Error('timeout')
  }
  deps.reveal = vi.fn()
  expect(await openStructuredAgentSession(sources[0]!, deps)).toMatchObject({
    kind: 'failed',
    failure: { reason: 'unreachable', beforeEffects: false }
  })
  expect(deps.reveal).not.toHaveBeenCalled()
})
it('never permits fallback after reveal succeeded, even if the subsequent activation is refused', async () => {
  const { deps } = rig()
  deps.activate = async () => {
    throw { code: 'forbidden' }
  }
  expect(await openStructuredAgentSession(sources[0]!, deps)).toMatchObject({
    kind: 'failed',
    failure: { reason: 'unsupported', beforeEffects: false }
  })
})
it('does not activate or reveal after the source loses ownership', async () => {
  const { deps } = rig()
  let current = true
  deps.current = () => current
  deps.refresh = async () => {
    current = false
  }
  expect(await openStructuredAgentSession(sources[0]!, deps)).toEqual({ kind: 'superseded' })
  expect(deps.activate).not.toHaveBeenCalled()
  expect(deps.reveal).not.toHaveBeenCalled()
})
it('round-trips only canonical notification identities', () => {
  const sessionId = 'root-123'
  const key = structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
  expect(structuredSessionIdFromNotificationPane(key)).toBe(sessionId)
  const wrongLeaf = structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), 'other')
  for (const invalid of [
    wrongLeaf,
    'structured-agent-session-:',
    'custom:invalid',
    structuredAgentSessionPaneKey('agent-chat-tab-v1-issued', sessionId),
    ` ${key}`
  ]) {
    expect(structuredSessionIdFromNotificationPane(invalid)).toBeNull()
  }
})

import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { PaneForegroundAgentEntry } from '../../store/slices/agent-status/pane-authority/pane-foreground-agent'
import {
  captureTerminalAgentImageTarget,
  prepareTerminalAgentImagePaths
} from './agent-image-preparation'

type State = {
  tabsByWorktree: object
  agentStatusByPaneKey: Map<string, AgentStatusEntry>
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry>
}
const rig = vi.hoisted(
  (): {
    state: State
    listeners: Set<(next: State, previous: State) => void>
    requests: { onEvent: (value: unknown) => void; onError: (error: unknown) => void }[]
  } => ({
    state: {
      tabsByWorktree: {},
      agentStatusByPaneKey: new Map<string, AgentStatusEntry>(),
      paneForegroundAgentByPaneKey: {}
    } satisfies State,
    listeners: new Set<(next: State, previous: State) => void>(),
    requests: []
  })
)
vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => rig.state,
    subscribe: (listener: (next: State, previous: State) => void) => {
      rig.listeners.add(listener)
      return () => rig.listeners.delete(listener)
    }
  }
}))
vi.mock('../hosted-terminals/identity/remote-runtime-pty-owner', () => ({
  getRemoteRuntimePtyOwner: () => null
}))
vi.mock('../rpc/subscriptions/runtime-rpc-subscribe', () => ({
  subscribeRuntimeRpc: async (
    _target: unknown,
    _method: string,
    _params: unknown,
    handlers: (typeof rig.requests)[number]
  ) => {
    rig.requests.push(handlers)
    return { unsubscribe: () => {} }
  }
}))
function entry(session = 'one'): AgentStatusEntry {
  return {
    paneKey: 'tab:leaf',
    agentType: 'claude',
    orcaSessionId: session,
    state: 'waiting',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: []
  }
}
function publish(state: State, notify = true) {
  const previous = rig.state
  rig.state = state
  if (notify) {
    for (const listener of rig.listeners) {
      listener(state, previous)
    }
  }
}
beforeEach(() => {
  rig.requests = []
  rig.listeners.clear()
  rig.state = {
    tabsByWorktree: {},
    agentStatusByPaneKey: new Map([['tab:leaf', entry()]]),
    paneForegroundAgentByPaneKey: { 'tab:leaf': { agent: 'claude', shellForeground: false } }
  }
})

it.each([true, false])(
  'does not deliver a delayed fitted image to the successor shell (exit notification=%s)',
  async (notify) => {
    const writes: string[] = []
    const captured = captureTerminalAgentImageTarget('tab', 'leaf')
    const flight = prepareTerminalAgentImagePaths('tab', 'leaf', 'pty', ['/repo/a.png'])
    const delivered = flight.then(
      (paths) => {
        writes.push(...paths)
        return 'delivered'
      },
      () => 'cancelled'
    )
    publish(
      {
        ...rig.state,
        paneForegroundAgentByPaneKey: { 'tab:leaf': { agent: null, shellForeground: true } }
      },
      notify
    )
    rig.requests[0].onEvent({ paths: ['/temp/a.png'] })
    await expect(delivered).resolves.toBe('cancelled')
    expect(writes).toEqual([])
    expect(captured?.isCurrent()).toBe(false)

    publish({
      ...rig.state,
      agentStatusByPaneKey: new Map([['tab:leaf', entry('two')]]),
      paneForegroundAgentByPaneKey: { 'tab:leaf': { agent: 'claude', shellForeground: false } }
    })
    const successor = prepareTerminalAgentImagePaths('tab', 'leaf', 'pty', ['/repo/b.png'])
    rig.requests.at(-1)!.onEvent({ paths: ['/temp/b.png'] })
    await expect(successor).resolves.toEqual(['/temp/b.png'])
  }
)

it('cancels a delayed image when a different conversation replaces the same agent on the same PTY', async () => {
  const flight = prepareTerminalAgentImagePaths('tab', 'leaf', 'pty', ['/repo/a.png'])
  const result = Promise.allSettled([flight])
  publish({ ...rig.state, agentStatusByPaneKey: new Map([['tab:leaf', entry('two')]]) })
  rig.requests[0].onEvent({ paths: ['/temp/a.png'] })
  expect((await result)[0].status).toBe('rejected')
})

it('retains a live idle agent and old-host fallback without reusing stale shell status', async () => {
  const flight = prepareTerminalAgentImagePaths('tab', 'leaf', 'pty', ['/repo/a.png'])
  publish({
    ...rig.state,
    agentStatusByPaneKey: new Map([['tab:leaf', { ...entry(), state: 'done' }]])
  })
  rig.requests[0].onError({ code: 'method_not_found' })
  await expect(flight).resolves.toEqual(['/repo/a.png'])
  publish({
    ...rig.state,
    agentStatusByPaneKey: new Map(),
    paneForegroundAgentByPaneKey: { 'tab:leaf': { agent: null, shellForeground: true } }
  })
  expect(captureTerminalAgentImageTarget('tab', 'leaf')).toBeNull()
})

it.each(['stale-shell', 'revoked-routing'])(
  'retains live hook-backed image sends despite %s evidence',
  async (kind) => {
    publish({
      ...rig.state,
      paneForegroundAgentByPaneKey: {
        'tab:leaf':
          kind === 'stale-shell'
            ? { agent: null, shellForeground: true }
            : { agent: 'claude', shellForeground: false, routingRevoked: true }
      }
    })
    const flight = prepareTerminalAgentImagePaths('tab', 'leaf', 'pty', ['/repo/a.png'])
    rig.requests[0].onEvent({ paths: ['/temp/a.png'] })
    await expect(flight).resolves.toEqual(['/temp/a.png'])
  }
)

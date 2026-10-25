// @vitest-environment happy-dom

import React, { act, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { ActivityThreadRow } from './activity-thread-row'
import type { AgentPaneThread } from './activity-thread-types'
import { makeRepo, makeTab, makeWorktree } from './ActivityPrototypePage-test-fixtures'

vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({
    children,
    onOpenChange
  }: {
    children: ReactNode
    onOpenChange?: (open: boolean) => void
  }) => {
    React.useEffect(() => onOpenChange?.(true), [onOpenChange])
    return <>{children}</>
  },
  HoverCardContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="hover-card-content">{children}</div>
  ),
  HoverCardTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function makeEnvironment(id: string, name: string): PublicKnownRuntimeEnvironment {
  return {
    id,
    name,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [{ id: 'ws', kind: 'websocket', label: 'WebSocket', endpoint: 'wss://box.example' }],
    preferredEndpointId: 'ws'
  }
}

function makeSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return { ...getDefaultSettings('/home/test'), ...overrides }
}

function makeThread(
  hostId: ExecutionHostId | undefined,
  overrides: Partial<AgentPaneThread> = {}
): AgentPaneThread {
  return {
    paneKey: 'tab-1:leaf-1',
    tab: makeTab(),
    worktree: { ...makeWorktree(), ...(hostId ? { hostId } : {}) },
    repo: makeRepo(),
    agentType: 'claude',
    latestEvent: null,
    currentAgentState: 'working',
    currentAgentEntry: null,
    events: [],
    unread: false,
    paneTitle: 'Audit current HEAD',
    responsePreview: 'Auditing terminal PTY',
    latestTimestamp: 1700000000000,
    ...overrides
  }
}

function Row({
  thread,
  compactMode = false
}: {
  thread: AgentPaneThread
  compactMode?: boolean
}): ReactElement {
  return (
    <TooltipProvider>
      <ActivityThreadRow
        thread={thread}
        selected={false}
        onSelect={vi.fn()}
        onJump={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkUnread={vi.fn()}
        canJump
        compactMode={compactMode}
      />
    </TooltipProvider>
  )
}

describe('activity row session host', () => {
  let container: HTMLDivElement
  let root: Root
  const initialState = useAppStore.getState()

  beforeEach(() => {
    useAppStore.setState({
      agentsAlwaysShowSessionHost: true,
      sshTargetLabels: new Map([['studio', 'Studio Mac mini']]),
      runtimeEnvironments: [
        makeEnvironment('env-a', 'Server A'),
        makeEnvironment('env-b', 'Server B'),
        // Whitespace-only: the selector trims, leaving only the raw environment id.
        makeEnvironment('env-unnamed', ' ')
      ],
      settings: makeSettings({ activeRuntimeEnvironmentId: 'env-a' })
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.replaceChildren()
    useAppStore.setState(initialState, true)
  })

  const renderRow = async (thread: AgentPaneThread, compactMode = false): Promise<void> => {
    await act(async () => root.render(<Row thread={thread} compactMode={compactMode} />))
  }
  const hostChip = (): string | undefined =>
    container.querySelector('[data-activity-session-host]')?.textContent ?? undefined

  it('keeps the default row unchanged while the preference is off', async () => {
    useAppStore.setState({ agentsAlwaysShowSessionHost: false })

    await renderRow(makeThread('ssh:studio'))

    expect(container.querySelector('[data-activity-session-host]')).toBeNull()
    expect(container.querySelector('[data-worktree-card-surface]')?.textContent).not.toContain(
      'Studio Mac mini'
    )
  })

  it.each([
    ['local', undefined, getLocalExecutionHostLabel()],
    ['an SSH target', 'ssh:studio' as const, 'Studio Mac mini'],
    ['a paired server', 'runtime:env-b' as const, 'Server B']
  ])(
    'shows %s on the row without hovering, in compact and detailed modes',
    async (_name, hostId, label) => {
      for (const compactMode of [true, false]) {
        await renderRow(makeThread(hostId), compactMode)
        expect(hostChip()).toBe(label)
      }
    }
  )

  it('follows a renamed host', async () => {
    useAppStore.setState({
      settings: makeSettings({
        hostSettingOverrides: { 'runtime:env-b': { displayLabel: 'Desk Mac' } }
      })
    })

    await renderRow(makeThread('runtime:env-b'))

    expect(hostChip()).toBe('Desk Mac')
  })

  it('shows the session-owned server rather than the focused one, in the row and its hover card', async () => {
    const thread = makeThread('local', { executionHostId: 'runtime:env-b' })

    await renderRow(thread)
    expect(hostChip()).toBe('Server B')

    useAppStore.setState({ settings: makeSettings({ activeRuntimeEnvironmentId: 'env-a' }) })
    await renderRow(thread)
    expect(hostChip()).toBe('Server B')
    expect(container.querySelector('[data-testid="hover-card-content"]')?.textContent).toContain(
      'Server B'
    )
  })

  it.each(['runtime:env-unnamed', 'runtime:env-uncataloged', 'runtime:unresolved-owner'] as const)(
    'omits a name-less host (%s) rather than showing a raw id or local',
    async (hostId) => {
      await renderRow(makeThread(hostId))

      expect(container.querySelector('[data-activity-session-host]')).toBeNull()
      expect(container.querySelector('[data-worktree-card-surface]')?.textContent).not.toContain(
        getLocalExecutionHostLabel()
      )
    }
  )
})

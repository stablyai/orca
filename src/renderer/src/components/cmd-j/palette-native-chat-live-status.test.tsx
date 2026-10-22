// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session-wire'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import type { RecentWorkspaceTabRow } from '@/lib/recent-workspace-tab-rows'
import type * as StructuredSessionClient from '@/runtime/structured-agent-session-client'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import { PaletteLiveStatusProvider, PaletteRecentTabStatusDot } from './palette-live-status'

const hostFeeds = vi.hoisted(() => new Map<string, (event: AgentSessionStatusEvent) => void>())

vi.mock('@/runtime/structured-agent-session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof StructuredSessionClient>()),
  subscribeStructuredAgentSessionStatus: async (
    target: RuntimeClientTarget,
    emit: (event: AgentSessionStatusEvent) => void
  ) => {
    const key = target.kind === 'local' ? 'local' : target.environmentId
    hostFeeds.set(key, emit)
    return { unsubscribe: () => hostFeeds.delete(key) }
  }
}))

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClient>()),
  runtimeEnvironmentSupportsCapability: async () => true
}))

vi.mock('@/components/AgentWorkingSpinner', () => ({
  AgentWorkingSpinner: () => <span data-spinner="true" />
}))

const initialAppState = useAppStore.getInitialState()
let root: Root
let container: HTMLDivElement

function nativeRow(executionHostId: ExecutionHostId = 'local'): RecentWorkspaceTabRow {
  return {
    id: `row-${executionHostId}`,
    worktreeId: 'folder:design',
    worktreeHostId: executionHostId,
    unifiedTabId: 'native-tab',
    terminalTab: null,
    nativeChat: { sessionId: 'native-session', executionHostId },
    worktreeLastActivityAt: 0
  }
}

function emit(host: string, overrides: Partial<AgentSessionStatusSummary> = {}): void {
  const publish = hostFeeds.get(host)
  if (!publish) {
    throw new Error(`No status subscription for ${host}`)
  }
  publish({
    type: 'status',
    session: {
      sessionId: 'native-session',
      workspaceId: 'folder:design',
      agent: 'codex',
      status: 'working',
      latestPrompt: '',
      updatedAt: Date.now(),
      ...overrides
    }
  })
}

function labels(): string[] {
  return [...container.querySelectorAll('.sr-only')].map((node) => node.textContent ?? '')
}

async function render(rows: RecentWorkspaceTabRow[], active = true): Promise<void> {
  await act(async () => {
    root.render(
      <TooltipProvider>
        <PaletteLiveStatusProvider active={active}>
          {rows.map((row) => (
            <PaletteRecentTabStatusDot
              key={row.id}
              row={row}
              fallback={<span data-content-icon="true" />}
            />
          ))}
        </PaletteLiveStatusProvider>
      </TooltipProvider>
    )
  })
}

describe('native Cmd+J live status', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    resetStructuredAgentSessionStatusFeedsForTests()
    hostFeeds.clear()
    useAppStore.setState(initialAppState, true)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    resetStructuredAgentSessionStatusFeedsForTests()
    useAppStore.setState(initialAppState, true)
    document.body.replaceChildren()
  })

  it('updates working, permission, idle and unread badges through the shared feed', async () => {
    await render([nativeRow()])
    expect(labels()).toEqual([])
    await act(async () => emit('local'))
    expect(labels()).toEqual(['Working'])
    expect(container.querySelector('[data-spinner]')).not.toBeNull()
    await act(async () => emit('local', { status: 'attention' }))
    expect(labels()).toEqual(['Needs permission'])
    await act(async () => emit('local', { status: 'idle' }))
    expect(labels()).toEqual(['Done'])
    await act(async () =>
      useAppStore.setState({
        unreadAgentCompletionPanes: {
          [structuredAgentSessionPaneKey('native-tab', 'native-session')]: true
        }
      })
    )
    expect(labels()).toEqual(['Unread agent completion'])
    expect(container.querySelector('[data-content-icon]')).not.toBeNull()
    await act(async () => emit('local', { status: 'attention' }))
    expect(labels()).toEqual(['Needs permission'])
  })

  it('keeps identical remote and local session ids on their owning feeds', async () => {
    const local = nativeRow()
    const remote = nativeRow('runtime:remote')
    local.nativeChat = { ...local.nativeChat!, ambiguousTabId: true }
    remote.nativeChat = { ...remote.nativeChat!, ambiguousTabId: true }
    await render([local, remote])
    await act(async () => {
      emit('local')
      emit('remote', { status: 'attention' })
    })
    expect(labels()).toEqual(['Working', 'Needs permission'])
    await act(async () => emit('remote', { workspaceId: 'other-folder', status: 'attention' }))
    expect(labels()).toEqual(['Working'])
    await act(async () =>
      emit('remote', { updatedAt: Date.now() - AGENT_STATUS_STALE_AFTER_MS - 60_000 })
    )
    expect(labels()).toEqual(['Working'])
    await act(async () =>
      emit('remote', {
        updatedAt: Date.now() - AGENT_STATUS_STALE_AFTER_MS - 60_000,
        hostExecutionOwned: true
      })
    )
    expect(labels()).toEqual(['Working', 'Working'])
    await act(async () => hostFeeds.get('remote')?.({ type: 'end' }))
    expect(labels()).toEqual(['Working'])
  })

  it('keeps the native status feed inactive while the palette is closed', async () => {
    await render([nativeRow('runtime:remote')], false)
    expect(hostFeeds.size).toBe(0)
    expect(labels()).toEqual([])
  })
})

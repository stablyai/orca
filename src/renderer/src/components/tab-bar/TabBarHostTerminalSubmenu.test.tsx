// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  createTestStore,
  makeWorktree,
  makeTabGroup,
  seedStore,
  TEST_REPO
} from '../../store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../../store/slices/store-cascades-test-harness'
import { toast } from 'sonner'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { TabBarHostTerminalSubmenu } from './TabBarHostTerminalSubmenu'
import { selectTerminalTabHostBadgeLabel } from './terminal-tab-host-badge'

type SubmenuMocks = {
  store: null | ReturnType<typeof createTestStore>
  callRuntimeRpc: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted((): SubmenuMocks => ({ store: null, callRuntimeRpc: vi.fn() }))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('../../store', () => ({
  get useAppStore() {
    return mocks.store
  }
}))
// Why plain elements: the Radix submenu needs an open root menu; these keep disabled/select observable.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuSub: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
    'data-host-terminal-target': target
  }: {
    children: React.ReactNode
    disabled?: boolean
    onSelect?: () => void
    'data-host-terminal-target'?: string
  }) => (
    <button type="button" disabled={disabled} onClick={onSelect} data-host-terminal-target={target}>
      {children}
    </button>
  )
}))

createStoreCascadesMockApi()

const WT = 'repo1::/path/wt1'

function environment(id: string, name: string, extra: { source?: 'ephemeral-vm' } = {}) {
  return {
    id,
    name,
    createdAt: 1,
    updatedAt: 1,
    pairingRevision: 1,
    lastUsedAt: null,
    runtimeId: id,
    preferredEndpointId: 'endpoint',
    endpoints: [{ id: 'endpoint', kind: 'websocket' as const, label: id, endpoint: 'ws://host' }],
    ...extra
  }
}

function setup(id: string, hostId: ExecutionHostId, repoId: string): ProjectHostSetup {
  return {
    id,
    projectId: 'project-1',
    hostId,
    repoId,
    path: `/setups/${id}`,
    displayName: repoId,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  }
}

function seed(
  worktree = makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1', projectId: 'project-1' }),
  options: { otherHosts?: boolean } = {}
) {
  const otherHosts = options.otherHosts ?? true
  const store = createTestStore()
  seedStore(store, {
    repos: [
      { ...TEST_REPO, executionHostId: 'local' },
      { ...TEST_REPO, id: 'env-repo', executionHostId: 'runtime:env-1' }
    ],
    worktreesByRepo: { repo1: [worktree] },
    endpointProjectHostSetups: [
      setup('local-setup', 'local', 'repo1'),
      setup('env-setup', 'runtime:env-1', 'env-repo')
    ],
    runtimeEnvironments: otherHosts ? [environment('env-1', 'dev box')] : [],
    sshTargetLabels: new Map(otherHosts ? [['builder', 'builder']] : []),
    groupsByWorktree: { [WT]: [makeTabGroup({ id: 'group-1', worktreeId: WT })] },
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {}
  })
  mocks.store = store
  return store
}

function renderSubmenu() {
  const onNewTerminalTab = vi.fn()
  const view = render(
    <TabBarHostTerminalSubmenu
      worktreeId={WT}
      groupId="group-1"
      onNewTerminalTab={onNewTerminalTab}
    />
  )
  const button = (hostId: string): HTMLButtonElement => {
    const found = view.container.querySelector<HTMLButtonElement>(
      `[data-host-terminal-target="${hostId}"]`
    )
    if (!found) {
      throw new Error(`no row for ${hostId}`)
    }
    return found
  }
  const hostIds = () =>
    [...view.container.querySelectorAll('[data-host-terminal-target]')].map((node) =>
      node.getAttribute('data-host-terminal-target')
    )
  return { view, onNewTerminalTab, button, hostIds }
}

afterEach(() => cleanup())
beforeEach(() => {
  seed()
  mocks.callRuntimeRpc.mockReset()
  vi.mocked(toast.error).mockClear()
})

describe('TabBarHostTerminalSubmenu', () => {
  it('lists the own host first and runtime hosts only', () => {
    expect(renderSubmenu().hostIds()).toEqual(['local', 'runtime:env-1'])
  })
  it('opens an ordinary terminal on its own host', () => {
    const view = renderSubmenu()
    fireEvent.click(view.button('local'))
    expect(view.onNewTerminalTab).toHaveBeenCalledOnce()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })
  it('opens the ready owner PTY with its stamp in the clicked group', async () => {
    const store = seed()
    mocks.callRuntimeRpc.mockResolvedValue({
      terminal: {
        handle: 'term-9',
        worktreeId: 'remote-wt',
        title: null,
        executionHostId: 'runtime:env-1',
        ptyId: 'remote:env-1@@term-9'
      }
    })
    const view = renderSubmenu()
    await act(async () => {
      fireEvent.click(view.button('runtime:env-1'))
    })
    const [tab] = store.getState().unifiedTabsByWorktree[WT] ?? []
    expect(tab).toMatchObject({
      groupId: 'group-1',
      executionHostId: 'runtime:env-1',
      projectHostSetupId: 'env-setup'
    })
    expect(store.getState().ptyIdsByTabId[tab.id]).toEqual(['remote:env-1@@term-9'])
    expect(view.onNewTerminalTab).not.toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).toHaveBeenCalledOnce()
  })
  it('shows a refusal after the menu unmounts, without a tab', async () => {
    const store = seed()
    let reject: (error: unknown) => void = () => {}
    mocks.callRuntimeRpc.mockReturnValue(
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise
      })
    )
    const view = renderSubmenu()
    fireEvent.click(view.button('runtime:env-1'))
    view.view.unmount()
    await act(async () => {
      reject(
        new RuntimeRpcCallError({
          id: '1',
          ok: false,
          error: { code: 'host_kind_not_supported_yet', message: 'no', data: {} }
        })
      )
    })
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledExactlyOnceWith(
        'Could not launch dev box in a new terminal.',
        { description: 'create_failed: host_kind_not_supported_yet' }
      )
    )
    expect(store.getState().unifiedTabsByWorktree[WT] ?? []).toEqual([])
  })
  it('keeps a host without a setup disabled', () => {
    const store = seed()
    store.setState({
      endpointProjectHostSetups: store
        .getState()
        .endpointProjectHostSetups.filter((row) => row.id !== 'env-setup')
    })
    const view = renderSubmenu()
    expect(view.button('runtime:env-1').disabled).toBe(true)
    fireEvent.click(view.button('runtime:env-1'))
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })
})

describe('selectTerminalTabHostBadgeLabel', () => {
  function withTab(tab: { executionHostId?: ExecutionHostId; projectHostSetupId?: string }) {
    const store = seed()
    store.setState({
      unifiedTabsByWorktree: {
        [WT]: [
          {
            id: 'tab-1',
            entityId: 'tab-1',
            groupId: 'group-1',
            worktreeId: WT,
            contentType: 'terminal',
            label: 'Terminal 1',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0,
            ...tab
          }
        ]
      }
    })
    return selectTerminalTabHostBadgeLabel(store.getState(), WT, 'tab-1')
  }

  it('names the host of a tab placed on another host', () => {
    expect(withTab({ executionHostId: 'runtime:env-1', projectHostSetupId: 'env-setup' })).toBe(
      'dev box'
    )
  })

  it('shows no badge for an ordinary tab or one on the worktree own host', () => {
    expect(withTab({})).toBeNull()
    expect(withTab({ executionHostId: 'runtime:env-1' })).toBeNull()
    expect(withTab({ executionHostId: 'local', projectHostSetupId: 'local-setup' })).toBeNull()
  })
})

// @vitest-environment happy-dom
//
// The pane, activation and close must address the owner stamped on the tab. Re-deriving from the
// worktree's current runtime owner pointed an open pane at whatever machine answered to that id.

import { cleanup, render } from '@testing-library/react'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import type { AppState } from '@/store/types'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(async () => ({})),
  closeStructuredAgentSession: vi.fn(async () => 'closed' as const),
  nativeChatProps: [] as Record<string, unknown>[],
  store: null as null | {
    getState: () => AppState
    setState: (state: Partial<AppState> & { testRuntimeOwner?: string | null }) => void
  }
}))

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  const useAppStore = createTestStore()
  mocks.store = useAppStore
  return { useAppStore }
})

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: (state: { testRuntimeOwner?: string | null }) =>
    state.testRuntimeOwner ?? null
}))

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClientModule>()),
  callRuntimeRpc: mocks.callRuntimeRpc
}))

vi.mock('@/runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: mocks.closeStructuredAgentSession
}))

vi.mock('@/lib/structured-agent-session-launch', () => ({
  cancelStructuredAgentLaunch: vi.fn()
}))

vi.mock('./NativeChatView', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.nativeChatProps.push(props)
    return null
  }
}))

vi.mock('../tab-group/RetainedPaneHost', () => ({
  RetainedPaneHost: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

import StructuredAgentSessionPaneOverlayLayer from './StructuredAgentSessionPaneOverlayLayer'
import { activateStructuredAgentSessionTab } from '@/lib/structured-agent-session-tab-activation'
import { createWorkspaceTabCloseCommands } from '../tab-group/workspace-tab-close-commands'
import { useTerminalPaneProjection } from '../terminal-pane/use-terminal-pane-projection'
import type { TerminalPaneMobileController } from '../terminal-pane/use-terminal-pane-mobile-actions'

const WORKTREE = 'wt-1'

function structuredTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'structured-tab-1',
    entityId: 'session-1',
    groupId: 'group-1',
    worktreeId: WORKTREE,
    contentType: 'agent-session',
    label: 'Codex Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    agentSessionAgent: 'codex',
    ...overrides
  }
}

/** The worktree's runtime owner after a remap; the stamped pane must ignore it. */
function seedStore(tab: Tab, testRuntimeOwner: string | null): void {
  mocks.store?.setState({
    unifiedTabsByWorktree: { [WORKTREE]: [tab] },
    groupsByWorktree: {
      [WORKTREE]: [
        {
          id: 'group-1',
          worktreeId: WORKTREE,
          activeTabId: tab.id,
          tabOrder: [tab.id],
          recentTabIds: [tab.id]
        }
      ]
    },
    activeGroupIdByWorktree: { [WORKTREE]: 'group-1' },
    testRuntimeOwner
  } as Partial<AppState>)
}

function renderOverlay(tab: Tab, testRuntimeOwner: string | null): Record<string, unknown> {
  seedStore(tab, testRuntimeOwner)
  render(<StructuredAgentSessionPaneOverlayLayer worktreeId={WORKTREE} isWorktreeActive />)
  const props = mocks.nativeChatProps.at(-1)
  if (!props) {
    throw new Error('overlay rendered no chat pane')
  }
  return props
}

/** Only the fields `useTerminalPaneProjection` reads for the structured chat target. */
function projectionController(
  overrides: Partial<TerminalPaneMobileController>
): TerminalPaneMobileController {
  return {
    applyNativeChatLeafRoute: vi.fn(),
    canToggleChatForLeaf: () => false,
    chatLeafId: null,
    contextMenu: { menuPaneId: null, open: false },
    contextMenuLeafId: null,
    effectiveChatViewMode: false,
    getContextMenuLeafId: () => null,
    getNativeChatLeafIds: () => [],
    getTabWideAgentHintLeafId: () => null,
    isActive: false,
    isChatEligibleForLeaf: () => false,
    isChatViewMode: false,
    isVisible: false,
    managerRef: { current: null },
    toggleNativeChatForLeaf: vi.fn(),
    paneTitles: {},
    paneTransportsRef: { current: new Map() },
    resolveTitleAgentForLeaf: () => null,
    setTerminalError: vi.fn(),
    setTerminalErrorsByPaneId: vi.fn(),
    settings: null,
    shouldMeasureHiddenStartup: false,
    structuredSessionAgent: 'codex',
    structuredSessionId: 'session-1',
    structuredSessionOwnerHostId: undefined,
    structuredSessionOwnerPairingRevision: undefined,
    fallbackRuntimeEnvironmentId: null,
    tabId: 'terminal-tab-1',
    sshReconnectOwnsTerminalErrors: false,
    systemPrefersDark: false,
    tabAgentTypeByLeaf: {},
    terminalError: null,
    terminalErrorsByPaneId: {},
    terminalTab: null,
    ...overrides
  } as unknown as TerminalPaneMobileController
}

beforeEach(() => {
  mocks.nativeChatProps.length = 0
  mocks.callRuntimeRpc.mockClear()
  mocks.closeStructuredAgentSession.mockClear()
  replaceRuntimeEnvironmentRevisions([
    { id: 'env-a', createdAt: 1, pairingRevision: 3 },
    { id: 'env-b', createdAt: 1, pairingRevision: 1 }
  ])
})

afterEach(() => {
  cleanup()
  replaceRuntimeEnvironmentRevisions([])
})

describe('the pane keeps the tab it was stamped for', () => {
  it('renders the overlay at the stamped owner after the worktree is remapped', () => {
    const props = renderOverlay(
      structuredTab({ executionHostId: 'runtime:env-a', runtimeOwnerPairingRevision: 3 }),
      'env-b'
    )
    expect(props.target).toEqual({ kind: 'environment', environmentId: 'env-a' })
    expect(props.ownerPairingStale).toBe(false)
  })

  it('renders the terminal-tab portal at the stamped owner, not a hardcoded local host', () => {
    const { result } = renderHook(() =>
      useTerminalPaneProjection(
        projectionController({
          structuredSessionOwnerHostId: 'runtime:env-a',
          structuredSessionOwnerPairingRevision: 3,
          fallbackRuntimeEnvironmentId: 'env-b'
        } as Partial<TerminalPaneMobileController>)
      )
    )
    expect(result.current.structuredChatTarget).toEqual({
      kind: 'environment',
      environmentId: 'env-a'
    })
    expect(result.current.structuredChatOwnerPairingStale).toBe(false)
  })

  it('keeps a local stamp local on both surfaces once the worktree is runtime-owned', () => {
    const props = renderOverlay(structuredTab({ executionHostId: 'local' }), 'env-b')
    expect(props.target).toEqual({ kind: 'local' })
    const { result } = renderHook(() =>
      useTerminalPaneProjection(
        projectionController({
          structuredSessionOwnerHostId: 'local',
          fallbackRuntimeEnvironmentId: 'env-b'
        } as Partial<TerminalPaneMobileController>)
      )
    )
    expect(result.current.structuredChatTarget).toEqual({ kind: 'local' })
  })
})

describe('a re-paired owner reads cached instead of retargeting', () => {
  it('flips the overlay to cached and keeps addressing the stamped environment', () => {
    const props = renderOverlay(
      structuredTab({ executionHostId: 'runtime:env-a', runtimeOwnerPairingRevision: 1 }),
      'env-a'
    )
    expect(props.ownerPairingStale).toBe(true)
    expect(props.ownerPairingRevision).toBe(1)
    expect(props.target).toEqual({ kind: 'environment', environmentId: 'env-a' })
  })

  it('flips the terminal-tab portal to cached too', () => {
    const { result } = renderHook(() =>
      useTerminalPaneProjection(
        projectionController({
          structuredSessionOwnerHostId: 'runtime:env-a',
          structuredSessionOwnerPairingRevision: 1,
          fallbackRuntimeEnvironmentId: 'env-a'
        } as Partial<TerminalPaneMobileController>)
      )
    )
    expect(result.current.structuredChatOwnerPairingStale).toBe(true)
    expect(result.current.structuredChatOwnerPairingRevision).toBe(1)
  })
})

describe('a legacy tab keeps the pre-stamp behaviour', () => {
  it('renders an unstamped tab at the worktree runtime and never reads as cached', () => {
    const local = renderOverlay(structuredTab(), null)
    expect(local.target).toEqual({ kind: 'local' })
    expect(local.ownerPairingStale).toBe(false)
    cleanup()
    mocks.nativeChatProps.length = 0
    const remapped = renderOverlay(structuredTab(), 'env-b')
    expect(remapped.target).toEqual({ kind: 'environment', environmentId: 'env-b' })
    expect(remapped.ownerPairingStale).toBe(false)
  })
})

describe('activation and close address the stamped owner', () => {
  it('activates against the stamp, fenced on the revision it was stamped at', () => {
    seedStore(
      structuredTab({ executionHostId: 'runtime:env-a', runtimeOwnerPairingRevision: 3 }),
      'env-b'
    )
    expect(
      activateStructuredAgentSessionTab({ worktreeId: WORKTREE, tabId: 'structured-tab-1' })
    ).toBe(true)
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-a' },
      'session.tabs.activate',
      expect.objectContaining({ tabId: 'agent-session:session-1' }),
      { expectedEnvironmentPairingRevision: 3 }
    )
  })

  it('closes against the stamp rather than the worktree runtime', async () => {
    const tab = structuredTab({ executionHostId: 'runtime:env-a', runtimeOwnerPairingRevision: 3 })
    seedStore(tab, 'env-b')
    const { closeItem } = createWorkspaceTabCloseCommands({
      worktreeId: WORKTREE,
      groupTabs: [tab]
    })
    closeItem(tab.id)
    await vi.waitFor(() => expect(mocks.closeStructuredAgentSession).toHaveBeenCalled())
    expect(mocks.closeStructuredAgentSession).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-a' },
      'session-1',
      { expectedEnvironmentPairingRevision: 3 }
    )
    await vi.waitFor(() =>
      expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
        { kind: 'environment', environmentId: 'env-a' },
        'session.tabs.close',
        expect.objectContaining({ tabId: 'agent-session:session-1' }),
        { expectedEnvironmentPairingRevision: 3 }
      )
    )
  })

  it('addresses a legacy tab exactly as before — the worktree runtime, unfenced', () => {
    seedStore(structuredTab(), null)
    activateStructuredAgentSessionTab({ worktreeId: WORKTREE, tabId: 'structured-tab-1' })
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'session.tabs.activate',
      expect.objectContaining({ tabId: 'agent-session:session-1' }),
      {}
    )
  })
})

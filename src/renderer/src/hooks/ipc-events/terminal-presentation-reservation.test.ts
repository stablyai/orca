import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TerminalCommandStateModule from './terminal-command-state'

type ActiveView = {
  activeView: string
  activeWorktreeId: string | null
  activePendingCreationId: string | null
}

const mocks = vi.hoisted(() => {
  const view: ActiveView = {
    activeView: 'terminal',
    activeWorktreeId: 'wt-1',
    activePendingCreationId: null
  }
  return {
    createTab: vi.fn(
      (_worktreeId: string, _groupId?: string, _type?: string, options?: { id?: string }) => ({
        id: options?.id ?? 'tab-new',
        title: 'Terminal'
      })
    ),
    setActiveTabType: vi.fn(),
    setActiveTab: vi.fn(),
    activateWorktree: vi.fn(),
    focusTab: vi.fn(),
    persistOrder: vi.fn(),
    backgroundMount: vi.fn(),
    replyTerminalCreate: vi.fn(),
    view
  }
})

vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => ({
      ...mocks.view,
      tabsByWorktree: {},
      settings: {},
      terminalLayoutsByTabId: {},
      createTab: mocks.createTab,
      setActiveTabType: mocks.setActiveTabType,
      setActiveTab: mocks.setActiveTab,
      revealWorktreeInSidebar: vi.fn(),
      setTabCustomTitle: vi.fn(),
      registerAgentLaunchConfig: vi.fn(),
      clearAgentLaunchConfig: vi.fn(),
      updateTabPtyId: vi.fn(),
      setTabLayout: vi.fn()
    })
  }
}))
vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: mocks.backgroundMount
}))
vi.mock('@/lib/terminal-tab-for-pty-id', () => ({
  resolveTerminalTabPtyOwnership: () => ({ kind: 'none' })
}))
vi.mock('@/lib/terminal-reveal-identity', () => ({ verifyTerminalRevealIdentity: () => undefined }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => null }))
vi.mock('@/lib/launch-agent-tab-order', () => ({ persistAgentLaunchTabOrder: mocks.persistOrder }))
vi.mock('./terminal-command-state', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalCommandStateModule>()),
  activateTerminalInitiatedWorktree: mocks.activateWorktree,
  focusTerminalInitiatedTab: mocks.focusTab
}))

import { registerTerminalPresentationIpcBridge } from './terminal-presentation-ipc-bridge'
import {
  agentLaunchReservedGroupIds,
  agentLaunchTabReservationCountForTests,
  reserveAgentLaunchTab
} from '@/lib/agent-launch-tab-reservations'

type RevealListener = (request: Record<string, unknown>) => void
let reveal: RevealListener
const releases: (() => void)[] = []

beforeEach(() => {
  vi.clearAllMocks()
  mocks.view = { activeView: 'terminal', activeWorktreeId: 'wt-1', activePendingCreationId: null }
  vi.stubGlobal('window', {
    api: {
      ui: {
        onCreateTerminal: (listener: RevealListener) => {
          reveal = listener
          return () => {}
        },
        onRequestTerminalTabMount: () => () => {},
        replyTerminalCreate: mocks.replyTerminalCreate
      }
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  })
  registerTerminalPresentationIpcBridge([])
})

afterEach(() => {
  releases.splice(0).forEach((release) => release())
  vi.unstubAllGlobals()
})

/** What main sends for a tab an `agent.launch` created: a background reveal with the minted ids. */
function hostReveal(tabId: string): Record<string, unknown> {
  return {
    requestId: 'req-1',
    worktreeId: 'wt-1',
    ptyId: 'pty-1',
    launchAgent: 'claude',
    activate: false,
    tabId,
    leafId: 'leaf-1'
  }
}

describe('revealing a tab an agent launch reserved', () => {
  it('places it in the button’s group, focuses it and reports it revealed', () => {
    const onRevealed = vi.fn()
    releases.push(
      reserveAgentLaunchTab('tab-reserved', {
        worktreeId: 'wt-1',
        groupId: 'group-2',
        onRevealed
      })
    )

    // The launch carried the button's view mode to the host, whose reveal passes it back.
    reveal({ ...hostReveal('tab-reserved'), viewMode: 'terminal' })

    expect(mocks.createTab).toHaveBeenCalledWith(
      'wt-1',
      'group-2',
      undefined,
      expect.objectContaining({ id: 'tab-reserved', activate: true, viewMode: 'terminal' })
    )
    expect(mocks.activateWorktree).toHaveBeenCalled()
    expect(mocks.setActiveTab).toHaveBeenCalledWith('tab-reserved')
    expect(mocks.focusTab).toHaveBeenCalledWith('tab-reserved', 'leaf-1', 'wt-1')
    expect(mocks.persistOrder).toHaveBeenCalledWith('wt-1', 'tab-reserved')
    expect(onRevealed).toHaveBeenCalledWith({
      tabId: 'tab-reserved',
      leafId: 'leaf-1',
      inView: true
    })
    expect(agentLaunchTabReservationCountForTests()).toBe(0)
  })

  // Why: the tab appears seconds after the click; pulling a user who moved on back to the launching
  // workspace is the bug #23974 fixed for creates.
  it.each([
    { left: 'to another workspace', view: { activeWorktreeId: 'wt-2' } },
    { left: 'to an app view', view: { activeView: 'settings' } }
  ])('leaves a user who went $left where they are and reports the tab unseen', ({ view }) => {
    mocks.view = { ...mocks.view, ...view }
    const onRevealed = vi.fn()
    releases.push(
      reserveAgentLaunchTab('tab-reserved', { worktreeId: 'wt-1', groupId: 'group-2', onRevealed })
    )

    reveal(hostReveal('tab-reserved'))

    expect(mocks.activateWorktree).not.toHaveBeenCalled()
    expect(mocks.setActiveTab).not.toHaveBeenCalled()
    expect(mocks.focusTab).not.toHaveBeenCalled()
    // Still the reserved group's tab, mounted so the agent starts without the workspace open.
    expect(mocks.createTab).toHaveBeenCalledWith(
      'wt-1',
      'group-2',
      undefined,
      expect.objectContaining({ id: 'tab-reserved', activate: true })
    )
    expect(mocks.backgroundMount).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabIds: ['tab-reserved']
    })
    expect(onRevealed).toHaveBeenCalledWith({
      tabId: 'tab-reserved',
      leafId: 'leaf-1',
      inView: false
    })
    expect(agentLaunchTabReservationCountForTests()).toBe(0)
  })

  // Why: activating the workspace reconciles tab groups, which drops an empty group no live
  // reservation holds; the tab then fell back to the first group (live QA, 2 of 2 runs).
  it('still holds the reserved group while it activates the workspace, before the tab exists', () => {
    const heldDuringActivation: string[][] = []
    mocks.activateWorktree.mockImplementation(() => {
      heldDuringActivation.push([...agentLaunchReservedGroupIds('wt-1')])
    })
    releases.push(reserveAgentLaunchTab('tab-reserved', { worktreeId: 'wt-1', groupId: 'group-2' }))

    reveal(hostReveal('tab-reserved'))

    expect(heldDuringActivation).toEqual([['group-2']])
    expect(agentLaunchTabReservationCountForTests()).toBe(0)
  })

  it('keeps the host’s default placement for a tab nobody reserved', () => {
    reveal(hostReveal('tab-unreserved'))

    expect(mocks.createTab).toHaveBeenCalledWith(
      'wt-1',
      undefined,
      undefined,
      expect.objectContaining({ id: 'tab-unreserved', activate: false })
    )
    expect(mocks.setActiveTab).not.toHaveBeenCalled()
    expect(mocks.persistOrder).not.toHaveBeenCalled()
  })

  it('still answers the host when the launch’s own callback throws', () => {
    releases.push(
      reserveAgentLaunchTab('tab-reserved', {
        worktreeId: 'wt-1',
        onRevealed: () => {
          throw new Error('caller bookkeeping failed')
        }
      })
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})

    reveal(hostReveal('tab-reserved'))

    expect(mocks.replyTerminalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-1', tabId: 'tab-reserved' })
    )
    expect(mocks.replyTerminalCreate.mock.calls[0]?.[0]).not.toHaveProperty('error')
  })
})

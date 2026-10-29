import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MountedTerminalTabRegistryModule from '@/runtime/mounted-terminal-tab-registry'
import type { PreloadApi } from '../../../preload/api-types'

type CreateTerminalPayload = Parameters<Parameters<PreloadApi['ui']['onCreateTerminal']>[0]>[0]

const { focusRuntimeTerminalSurface } = vi.hoisted(() => ({
  focusRuntimeTerminalSurface: vi.fn(() => true)
}))

vi.mock('@/runtime/mounted-terminal-tab-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof MountedTerminalTabRegistryModule>()),
  focusRuntimeTerminalSurface
}))

import { useAppStore } from '@/store'
import { registerTerminalPresentationIpcBridge } from '@/hooks/ipc-events/terminal-presentation-ipc-bridge'
import { activateAndRevealWorktree } from './worktree-activation'
import { queueWorkspaceActivationTerminalFocus } from './workspace-activation-terminal-focus'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from './worktree-activation-created-agent.test-fixture'

const initialAppStoreState = useAppStore.getState()
const AGENT_TAB_ID = 'b1a1c0de-0000-4000-8000-000000000001'
const AGENT_LEAF_ID = 'b1a1c0de-0000-4000-8000-000000000002'
const SETUP_TAB_ID = 'b1a1c0de-0000-4000-8000-000000000003'
const SETUP_LEAF_ID = 'b1a1c0de-0000-4000-8000-000000000004'

let revealTerminal: (payload: CreateTerminalPayload) => void
let frames: FrameRequestCallback[]

beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
  vi.stubGlobal('document', {
    activeElement: null,
    body: {},
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {}
  })
  vi.stubGlobal('window', {
    api: {
      ui: {
        onCreateTerminal: (listener: typeof revealTerminal) => {
          revealTerminal = listener
          return () => {}
        },
        onLaunchRecipe: () => () => {},
        onRequestTerminalTabMount: () => () => {},
        replyTerminalCreate: vi.fn()
      }
    }
  })
  registerTerminalPresentationIpcBridge([])
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

describe('a local agent create watched to completion', () => {
  it('opens on and focuses the agent tab the host adopted without activating', () => {
    const worktree = makeCreatedAgentWorktree()
    seedEmptyActivatableWorktree(worktree)
    useAppStore.setState({ activeWorktreeId: null, activeTabId: null })

    // The host reveals its startup and setup terminals as main sends them for a local create.
    revealTerminal({
      requestId: 'reveal-agent',
      worktreeId: worktree.id,
      ptyId: 'pty-agent',
      launchAgent: 'codex',
      activate: false,
      surfaceOwner: false,
      tabId: AGENT_TAB_ID,
      leafId: AGENT_LEAF_ID
    })
    revealTerminal({
      requestId: 'reveal-setup',
      worktreeId: worktree.id,
      ptyId: 'pty-setup',
      title: 'Setup',
      activate: false,
      surfaceOwner: false,
      tabId: SETUP_TAB_ID,
      leafId: SETUP_LEAF_ID
    })
    expect(useAppStore.getState().activeWorktreeId).toBeNull()

    // The completion rule's activation for a user still on the creation panel.
    const activation = activateAndRevealWorktree(worktree.id, {
      sidebarRevealBehavior: 'auto',
      agent: 'codex',
      backendStartupTerminalSpawned: true
    })
    expect(activation).toEqual({ primaryTabId: null })
    expect(useAppStore.getState().tabsByWorktree[worktree.id]?.map((tab) => tab.id)).toEqual([
      AGENT_TAB_ID,
      SETUP_TAB_ID
    ])

    expect(queueWorkspaceActivationTerminalFocus(worktree.id, activation)).toBe(true)
    frames.shift()?.(0)
    expect(focusRuntimeTerminalSurface).toHaveBeenCalledWith(AGENT_TAB_ID, null, worktree.id)
  })
})

describe('host reveal after early launch publication fails', () => {
  it.each([
    { viewer: 'focus-in-workspace', moved: true, follows: false },
    { viewer: 'focus-in-workspace', moved: false, follows: true },
    { viewer: 'focus-window', moved: true, follows: true },
    { viewer: 'none', moved: true, follows: false }
  ] as const)(
    'honors $viewer after navigation=$moved for new and existing panes',
    ({ viewer, moved, follows }) => {
      const worktree = makeCreatedAgentWorktree()
      const other = { ...worktree, id: `${worktree.id}-other` }
      const { revealWorktreeInSidebar } = seedEmptyActivatableWorktree(worktree, {
        extraWorktrees: [other]
      })
      const activeWorkspace = moved ? other.id : worktree.id
      useAppStore.setState({ activeWorktreeId: activeWorkspace, activeTabId: null })
      focusRuntimeTerminalSurface.mockClear()
      const payload: CreateTerminalPayload = {
        requestId: 'reveal-agent',
        worktreeId: worktree.id,
        ptyId: 'pty-agent',
        launchAgent: 'codex',
        activate: false,
        surfaceOwner: false,
        agentLaunchViewer: viewer,
        tabId: AGENT_TAB_ID,
        leafId: AGENT_LEAF_ID
      }
      revealTerminal(payload)
      expect(useAppStore.getState().activeWorktreeId).toBe(follows ? worktree.id : activeWorkspace)
      expect(useAppStore.getState().tabsByWorktree[worktree.id]?.map((tab) => tab.id)).toEqual([
        AGENT_TAB_ID
      ])
      expect(useAppStore.getState().terminalLayoutsByTabId[AGENT_TAB_ID]?.ptyIdsByLeafId).toEqual({
        [AGENT_LEAF_ID]: 'pty-agent'
      })
      if (follows) {
        expect(useAppStore.getState().activeTabId).toBe(AGENT_TAB_ID)
        expect(focusRuntimeTerminalSurface).toHaveBeenCalledWith(
          AGENT_TAB_ID,
          AGENT_LEAF_ID,
          worktree.id
        )
      } else {
        expect(focusRuntimeTerminalSurface).not.toHaveBeenCalled()
        expect(useAppStore.getState().activeTabId).toBeNull()
      }
      if (viewer === 'focus-in-workspace') {
        expect(revealWorktreeInSidebar).not.toHaveBeenCalled()
      }
      // A reveal can find a tab restored while its earlier publication reply was lost.
      useAppStore.setState({ activeWorktreeId: activeWorkspace, activeTabId: null })
      focusRuntimeTerminalSurface.mockClear()
      revealTerminal(payload)
      expect(useAppStore.getState().activeWorktreeId).toBe(follows ? worktree.id : activeWorkspace)
      expect(useAppStore.getState().tabsByWorktree[worktree.id]).toHaveLength(1)
      if (follows) {
        expect(focusRuntimeTerminalSurface).toHaveBeenCalledOnce()
      } else {
        expect(focusRuntimeTerminalSurface).not.toHaveBeenCalled()
      }
    }
  )
})

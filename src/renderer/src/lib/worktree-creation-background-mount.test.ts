import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import type * as BackgroundMountModule from '@/components/terminal/background-terminal-worktree-mount'

const { requestMount, mainStarts } = vi.hoisted(() => {
  const started: unknown[] = []
  return { requestMount: vi.fn(), mainStarts: started }
})

vi.mock('@/components/terminal/background-terminal-worktree-mount', async (importOriginal) => ({
  ...(await importOriginal<typeof BackgroundMountModule>()),
  requestBackgroundTerminalWorktreeMount: requestMount
}))

vi.mock('@/lib/new-workspace', () => ({
  ensureAgentStartupInTerminal: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() }
}))

import { useAppStore } from '@/store'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { runBackgroundWorktreeCreation } from './worktree-creation-flow'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from './worktree-activation-created-agent.test-fixture'

// Main's answer to the window's layout commands, as a switch-on build sends them, and the first
// terminals it starts for the window's new tabs.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const client = (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
  return {
    ...client,
    callRuntimeRpc: (...args: Parameters<typeof client.callRuntimeRpc>) => {
      if (args[1] !== 'terminal.create') {
        return client.callRuntimeRpc(...args)
      }
      mainStarts.push(args[2])
      return new Promise(() => undefined)
    }
  }
})

/** Whether the tab's startup runs: main runs it in a layout-owner build, else the window's mount. */
function startupRuns(tabId: string): boolean {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return useAppStore.getState().pendingStartupByTabId[tabId] !== undefined
  }
  return mainStarts.some(
    (params) =>
      typeof params === 'object' && params !== null && 'tabId' in params && params.tabId === tabId
  )
}

/** Whether the user sees the terminal titled Setup: a layout-owner build sends the title to main,
 *  whose frame (not modelled here) draws it; otherwise the window titles the row itself. */
function titledSetup(terminal: { id: string; customTitle?: string | null }): boolean {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return terminal.customTitle === 'Setup'
  }
  const tabBarId = useAppStore
    .getState()
    .unifiedTabsByWorktree[worktree.id]?.find((tab) => tab.entityId === terminal.id)?.id
  return layoutApplyTestTransport
    .sentOfType('renameTab')
    .some((rename) => rename.tabId === tabBarId && rename.title === 'Setup')
}

const initialAppStoreState = useAppStore.getState()
const worktree = makeCreatedAgentWorktree()

function makeAgentRequest(): WorktreeCreationRequest {
  return {
    repoId: worktree.repoId,
    name: 'feature',
    setupDecision: 'run',
    agent: 'codex',
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: {
      agent: 'codex',
      launchCommand: 'codex',
      expectedProcess: 'codex',
      followupPrompt: null,
      launchConfig: { agentArgs: '', agentEnv: {} }
    },
    quickPrompt: '',
    quickTelemetry: null
  }
}

function makeBlankTerminalRequest(
  overrides: Partial<WorktreeCreationRequest> = {}
): WorktreeCreationRequest {
  return { ...makeAgentRequest(), agent: null, startupPlan: null, ...overrides }
}

// Submits from the composer, then moves the user off the creation panel before the create lands.
async function createAfterUserSwitchedAway(
  result: CreateWorktreeResult,
  request: WorktreeCreationRequest = makeAgentRequest()
): Promise<void> {
  const createWorktree = vi.fn(async () => result)
  useAppStore.setState({ createWorktree })
  const creationId = runBackgroundWorktreeCreation(request)
  useAppStore.setState({ activePendingCreationId: null })
  await vi.waitFor(() =>
    expect(useAppStore.getState().pendingWorktreeCreations[creationId]).toBeUndefined()
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mainStarts.length = 0
  seedEmptyActivatableWorktree(worktree)
})

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

describe('a create finishing after the user switched away', () => {
  it('mounts the seeded agent and setup tabs in the background so their startup runs', async () => {
    // SSH-like: the host started nothing, so the renderer seeds the agent and setup terminals.
    await createAfterUserSwitchedAway({
      worktree,
      setup: { runnerScriptPath: '/workspace/repo/.git/orca/setup-runner.sh', envVars: {} }
    })

    const state = useAppStore.getState()
    const tabs = state.tabsByWorktree[worktree.id] ?? []
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(2)
    expect(tabs.every((tab) => startupRuns(tab.id))).toBe(true)
    expect(state.activeWorktreeId).toBeNull()
    expect(requestMount).toHaveBeenCalledWith({
      worktreeId: worktree.id,
      tabIds: tabs.map((tab) => tab.id)
    })
  })

  it('mounts a fallback setup tab but not the agent terminal the host already started', async () => {
    const hostTab = useAppStore.getState().createTab(worktree.id, undefined, undefined, {
      initialPtyId: 'pty-agent',
      activate: false,
      launchAgent: 'codex'
    })

    // The host started the agent but could not start setup, so it hands setup back.
    await createAfterUserSwitchedAway({
      worktree,
      startupTerminal: { spawned: true, surface: 'visible' },
      setup: { runnerScriptPath: '/workspace/repo/.git/orca/setup-runner.sh', envVars: {} }
    })

    const tabs = useAppStore.getState().tabsByWorktree[worktree.id] ?? []
    expect(tabs).toHaveLength(2)
    const setupTab = tabs.find((tab) => tab.id !== hostTab.id)
    expect(requestMount).toHaveBeenCalledTimes(1)
    expect(requestMount).toHaveBeenCalledWith({ worktreeId: worktree.id, tabIds: [setupTab?.id] })
  })

  it('mounts the dedicated Setup tab beside an idle primary terminal', async () => {
    await createAfterUserSwitchedAway(
      {
        worktree,
        setup: { runnerScriptPath: '/workspace/repo/.git/orca/setup-runner.sh', envVars: {} }
      },
      makeBlankTerminalRequest()
    )
    const next = useAppStore.getState()
    const tabs = next.tabsByWorktree[worktree.id] ?? []
    expect(tabs).toHaveLength(2)
    const setupTab = tabs.find(titledSetup)
    expect(setupTab).toBeDefined()
    expect(requestMount).toHaveBeenCalledExactlyOnceWith({
      worktreeId: worktree.id,
      tabIds: [setupTab?.id]
    })
    expect(next.activeWorktreeId).toBeNull()
  })

  it.each(['split-vertical', 'split-horizontal', 'new-tab'] as const)(
    'keeps setup-only creation to one tab with retired location %s',
    async (setupScriptLaunchMode) => {
      const currentSettings = useAppStore.getState().settings
      if (!currentSettings) {
        throw new Error('missing creation settings')
      }
      const settings = { ...currentSettings, setupScriptLaunchMode }
      useAppStore.setState({ settings })
      await createAfterUserSwitchedAway(
        {
          worktree,
          setup: { runnerScriptPath: '/workspace/setup.sh', envVars: {} },
          defaultTabs: { tabs: [{ title: 'Dev', command: 'pnpm dev' }], runCommands: true }
        },
        makeBlankTerminalRequest({ setupOnly: true })
      )
      const next = useAppStore.getState()
      expect(next.tabsByWorktree[worktree.id]).toHaveLength(1)
      expect(titledSetup(next.tabsByWorktree[worktree.id]![0]!)).toBe(true)
      expect(next.activeWorktreeId).toBeNull()
    }
  )

  it('mounts a plain terminal whose only work is a queued issue-command split', async () => {
    await createAfterUserSwitchedAway(
      { worktree },
      makeBlankTerminalRequest({ issueCommand: { command: 'echo issue' } })
    )

    const next = useAppStore.getState()
    const tabs = next.tabsByWorktree[worktree.id] ?? []
    expect(tabs).toHaveLength(1)
    const tabId = tabs[0]?.id ?? ''
    expect(next.pendingStartupByTabId[tabId]).toBeUndefined()
    expect(next.pendingIssueCommandSplitByTabId[tabId]).toBeDefined()
    expect(requestMount).toHaveBeenCalledWith({ worktreeId: worktree.id, tabIds: [tabId] })
  })
})

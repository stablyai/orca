import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import type * as BackgroundMountModule from '@/components/terminal/background-terminal-worktree-mount'

const { requestMount } = vi.hoisted(() => ({ requestMount: vi.fn() }))

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
import { runBackgroundWorktreeCreation } from './worktree-creation-flow'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from './worktree-activation-created-agent-test-state'

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
    expect(tabs.every((tab) => state.pendingStartupByTabId[tab.id] !== undefined)).toBe(true)
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

  it('mounts a plain terminal whose only work is a queued setup split', async () => {
    useAppStore.setState((current) => ({
      settings: current.settings && { ...current.settings, setupScriptLaunchMode: 'split-vertical' }
    }))

    await createAfterUserSwitchedAway(
      {
        worktree,
        setup: { runnerScriptPath: '/workspace/repo/.git/orca/setup-runner.sh', envVars: {} }
      },
      makeBlankTerminalRequest()
    )

    const next = useAppStore.getState()
    const tabs = next.tabsByWorktree[worktree.id] ?? []
    expect(tabs).toHaveLength(1)
    const tabId = tabs[0]?.id ?? ''
    expect(next.pendingStartupByTabId[tabId]).toBeUndefined()
    expect(next.pendingSetupSplitByTabId[tabId]).toBeDefined()
    expect(requestMount).toHaveBeenCalledWith({ worktreeId: worktree.id, tabIds: [tabId] })
  })

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

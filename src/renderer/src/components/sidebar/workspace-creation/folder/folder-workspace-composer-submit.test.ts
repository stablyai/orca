// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeProjectGroup, makeFolderWorkspace } from './folder-workspace-composer-submit-fixtures'

import type * as NewWorkspaceModule from '@/lib/new-workspace'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  ensureAgentStartupInTerminal: vi.fn()
}))

vi.mock('@/lib/worktree-activation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace }
})

vi.mock('@/lib/new-workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof NewWorkspaceModule>()
  return {
    ...actual,
    ensureAgentStartupInTerminal: mocks.ensureAgentStartupInTerminal
  }
})

import { useAppStore } from '@/store/index'
import { submitFolderWorkspaceCreate } from './folder-workspace-composer-submit'

const ISSUE_URL = 'https://github.com/stablyai/orca/issues/42'
const linkedIssue = {
  provider: 'github' as const,
  type: 'issue' as const,
  number: 42,
  title: 'Restore linked quick-create',
  url: ISSUE_URL,
  repoId: 'repo-1'
}

describe('submitFolderWorkspaceCreate native-chat launch draft', () => {
  function seededDraftFor(tabId: string): { text: string } | undefined {
    return useAppStore.getState().nativeChatLaunchDraftByTabId[tabId]
  }

  beforeEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
    useAppStore.setState({ nativeChatLaunchDraftByTabId: {} })
  })

  afterEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReset()
    mocks.ensureAgentStartupInTerminal.mockReset()
    useAppStore.setState({ nativeChatLaunchDraftByTabId: {} })
    vi.restoreAllMocks()
  })

  it('mirrors a startup-paste draft into the chat composer', async () => {
    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem: linkedIssue,
      note: '',
      quickAgent: 'codex',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace: vi.fn(async () => makeFolderWorkspace()),
      onOpenChange: vi.fn()
    })

    expect(seededDraftFor('tab-1')?.text).toBe(ISSUE_URL)
  })

  it('mirrors an argv-prefill draft, which never lands in startupPlan.draftPrompt', async () => {
    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem: linkedIssue,
      note: '',
      quickAgent: 'claude',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace: vi.fn(async () => makeFolderWorkspace()),
      onOpenChange: vi.fn()
    })

    // Argv prefill carries no draftPrompt, so it cannot decide whether chat should mirror the draft.
    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup
    expect(startup?.draftPrompt).toBeUndefined()
    expect(startup?.command).toContain(ISSUE_URL)
    expect(seededDraftFor('tab-1')?.text).toBe(ISSUE_URL)
  })
})

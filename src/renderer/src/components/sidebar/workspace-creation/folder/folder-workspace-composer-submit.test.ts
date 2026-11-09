// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeProjectGroup, makeFolderWorkspace } from './folder-workspace-composer-submit-fixtures'

import type * as NewWorkspaceModule from '@/lib/new-workspace'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  ensureAgentStartupInTerminal: vi.fn()
}))

vi.mock('@/lib/workspace/activation/worktree-activation', async (importOriginal) => {
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

it('keeps the folder legacy Arguments projection while carrying the entire non-native draft to the paired pane', async () => {
  mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'folder-agent' })
  await submitFolderWorkspaceCreate({
    projectGroup: makeProjectGroup(),
    name: 'folder',
    lastAutoName: '',
    linkedWorkItem: linkedIssue,
    note: 'keep this note',
    quickAgent: 'codex',
    autoRenameBranchFromWork: false,
    agentCmdOverrides: {},
    launchInputs: { sessionOptions: { model: 'gpt-picked' } },
    legacyLaunchInputs: {
      agentArgs: '--add-dir /host/shared',
      sessionOptions: { model: 'gpt-picked' }
    },
    createFolderWorkspace: vi.fn(async () => makeFolderWorkspace()),
    onOpenChange: vi.fn()
  })
  const startup = mocks.activateAndRevealFolderWorkspace.mock.calls.at(-1)?.[1].startup
  expect(startup.command).toContain("'/host/shared'")
  expect(startup.freshAgentLaunch.agentArgs).toBeUndefined()
  expect(startup.freshAgentLaunch.prompt).toContain(ISSUE_URL)
  expect(startup.freshAgentLaunch.prompt).toContain('keep this note')
  expect(startup.freshAgentLaunch.legacy()).toMatchObject({
    pasteDraftAfterLaunch: expect.stringContaining('keep this note'),
    submitPastedPrompt: false
  })
})

it('delivers an old-host Aider folder note using the plan whose bare command executes', async () => {
  mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'folder-aider' })
  await submitFolderWorkspaceCreate({
    projectGroup: makeProjectGroup(),
    name: 'folder',
    lastAutoName: '',
    linkedWorkItem: null,
    note: 'fix the folder',
    quickAgent: 'aider',
    autoRenameBranchFromWork: false,
    agentCmdOverrides: {},
    createFolderWorkspace: vi.fn(async () => makeFolderWorkspace()),
    onOpenChange: vi.fn()
  })
  const startup = mocks.activateAndRevealFolderWorkspace.mock.lastCall?.[1].startup
  expect(startup.command).toBe('aider')
  const compatibility = startup.freshAgentLaunch.legacy()
  expect(compatibility.startupPlan.launchCommand).toBe('aider')
  expect(compatibility.pasteDraftAfterLaunch).toBe('fix the folder')
  expect(compatibility.submitPastedPrompt).toBe(true)
})

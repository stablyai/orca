// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeProjectGroup, makeFolderWorkspace } from './folder-workspace-composer-submit-fixtures'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type * as NewWorkspaceModule from '@/lib/new-workspace'
import { getDefaultSettings } from '../../../../shared/constants'

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

import { useAppStore } from '@/store'
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

describe('submitFolderWorkspaceCreate', () => {
  it.each(['claude', 'codex'] as const)(
    'retains untouched ordinary %s Settings in the complete initial folder startup',
    async (agent) => {
      const previous = useAppStore.getState().settings
      const raw = agent === 'claude' ? '--verbose' : '--search'
      const model = agent === 'claude' ? 'opus' : 'gpt-5.4'
      const settings = {
        ...getDefaultSettings('/test'),
        agentDefaultSurface: 'terminal' as const,
        agentPermissionDefault: 'own' as const,
        agentDefaultArgs: { [agent]: raw },
        agentLaunchChoices: { [agent]: { model, options: { effort: 'low' } } }
      }
      useAppStore.setState({ settings })
      const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
      const onOpenChange = vi.fn()
      try {
        expect(
          await submitFolderWorkspaceCreate({
            projectGroup: makeProjectGroup(),
            name: 'hi',
            lastAutoName: '',
            linkedWorkItem: null,
            note: '',
            quickAgent: agent,
            autoRenameBranchFromWork: false,
            settings,
            agentCmdOverrides: {},
            launchSource: 'new_workspace_composer',
            createFolderWorkspace,
            onOpenChange
          })
        ).toBe(true)
        const command =
          agent === 'claude'
            ? "claude '--verbose' '--model' 'opus' '--effort' 'low'"
            : `codex '-c' 'disable_paste_burst=true' '--search' '-m' 'gpt-5.4' '-c' 'model_reasoning_effort=low'`
        expect(createFolderWorkspace.mock.calls).toEqual([
          [
            {
              projectGroupId: 'group-1',
              name: 'hi',
              connectionId: null,
              linkedTask: null,
              createdWithAgent: agent
            }
          ]
        ])
        expect(mocks.activateAndRevealFolderWorkspace.mock.calls).toEqual([
          [
            'folder-workspace-1',
            {
              agent,
              runtimeEnvironmentId: null,
              startup: {
                command,
                env: {},
                launchConfig: { agentCommand: `${agent} '${raw}'`, agentArgs: raw, agentEnv: {} },
                launchToken: expect.stringMatching(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
                launchAgent: agent,
                telemetry: {
                  agent_kind: agent === 'claude' ? 'claude-code' : 'codex',
                  launch_source: 'new_workspace_composer',
                  request_kind: 'new'
                }
              }
            }
          ]
        ])
        expect(onOpenChange.mock.calls).toEqual([[false]])
        expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
      } finally {
        useAppStore.setState({ settings: previous })
      }
    }
  )

  beforeEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
  })

  afterEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReset()
    mocks.ensureAgentStartupInTerminal.mockReset()
    vi.restoreAllMocks()
  })

  it('keeps linked Codex context out of submitted startup and pastes it as a draft', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const linkedWorkItem = {
      provider: 'github' as const,
      type: 'pr' as const,
      number: 91,
      title: 'Restore linked quick-create',
      url: 'https://github.com/stablyai/orca/pull/91',
      repoId: 'repo-1'
    }

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem,
      note: 'Review this before starting',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      launchSource: 'new_workspace_composer',
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'Restore linked quick-create',
      connectionId: null,
      linkedTask: linkedWorkItem,
      createdWithAgent: 'codex'
    })
    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup
    expect(startup?.command).toBe("codex '-c' 'disable_paste_burst=true'")
    expect(startup?.command).not.toContain(linkedWorkItem.url)
    expect(startup?.command).not.toContain('Review this before starting')
    expect(mocks.ensureAgentStartupInTerminal).toHaveBeenCalledWith({
      worktreeId: folderWorkspaceKey('folder-workspace-1'),
      primaryTabId: 'tab-1',
      startup: expect.objectContaining({
        agent: 'codex',
        launchCommand: "codex '-c' 'disable_paste_burst=true'",
        followupPrompt: null,
        draftPrompt: `Review this before starting\n\n${linkedWorkItem.url}`
      })
    })
  })

  it('pastes the linked draft for remote Codex folder workspaces', async () => {
    const createFolderWorkspace = vi.fn(async () =>
      makeFolderWorkspace({
        connectionId: 'ssh-1',
        folderPath: '/home/alice/platform/Trust remote folder draft'
      })
    )
    const linkedWorkItem = {
      provider: 'github' as const,
      type: 'pr' as const,
      number: 92,
      title: 'Trust remote folder draft',
      url: 'https://github.com/stablyai/orca/pull/92',
      repoId: 'repo-1'
    }
    const projectGroup = {
      ...makeProjectGroup(),
      connectionId: 'ssh-1',
      parentPath: '/home/alice/platform'
    }
    useAppStore.setState({
      sshConnectionStates: new Map([
        [
          'ssh-1',
          {
            targetId: 'ssh-1',
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            remotePlatform: 'linux'
          }
        ]
      ])
    })

    await submitFolderWorkspaceCreate({
      projectGroup,
      name: '',
      lastAutoName: '',
      linkedWorkItem,
      note: '',
      quickAgent: 'codex',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      isRemote: true,
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(mocks.ensureAgentStartupInTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: folderWorkspaceKey('folder-workspace-1'),
        startup: expect.objectContaining({
          agent: 'codex',
          draftPrompt: linkedWorkItem.url
        })
      })
    )
  })

  it('delivers non-linked follow-up prompts for agents that need stdin after launch', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: 'Aider followup',
      lastAutoName: '',
      linkedWorkItem: null,
      note: 'Fix the failing folder prompt flow',
      quickAgent: 'aider',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup
    expect(startup?.command).toBe('aider')
    expect(mocks.ensureAgentStartupInTerminal).toHaveBeenCalledWith({
      worktreeId: folderWorkspaceKey('folder-workspace-1'),
      primaryTabId: 'tab-1',
      startup: expect.objectContaining({
        agent: 'aider',
        launchCommand: 'aider',
        followupPrompt: 'Fix the failing folder prompt flow'
      })
    })
  })

  it('uses native draft launch for linked agents with prefill support', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const linkedWorkItem = {
      provider: 'gitlab' as const,
      type: 'mr' as const,
      number: 17,
      title: 'Review folder workspace draft',
      url: 'https://gitlab.example.com/group/project/-/merge_requests/17',
      repoId: 'repo-1'
    }

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem,
      note: 'Check the migration path',
      quickAgent: 'claude',
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup
    expect(startup?.command).toContain('claude --prefill')
    expect(startup?.command).toContain('Check the migration path')
    expect(startup?.command).toContain(linkedWorkItem.url)
    expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
  })
})

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

it.each(['claude', 'codex'] as const)(
  'rejects invalid requested %s startup before folder creation and preserves valid options',
  async (agent) => {
    const input = {
      projectGroup: makeProjectGroup(),
      name: 'configured',
      lastAutoName: '',
      linkedWorkItem: null,
      note: 'fix',
      quickAgent: agent,
      launchChoice: { agent, route: 'terminal-tui' as const },
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      agentArgs: '--add-dir "docs',
      sessionOptions: { model: agent === 'claude' ? 'sonnet' : 'gpt-5.4' },
      createFolderWorkspace: vi.fn(async () => makeFolderWorkspace()),
      onOpenChange: vi.fn()
    }
    for (const linkedWorkItem of [null, linkedIssue]) {
      await expect(submitFolderWorkspaceCreate({ ...input, linkedWorkItem })).rejects.toThrow(
        'Check Arguments in this setup'
      )
      expect(input.createFolderWorkspace).not.toHaveBeenCalled()
      expect(input.onOpenChange).not.toHaveBeenCalled()
    }
    expect(await submitFolderWorkspaceCreate({ ...input, agentArgs: '--add-dir docs' })).toBe(true)
    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls.at(-1)?.[1]?.startup
    expect(startup.command).toMatch(/--add-dir.*docs/)
    expect(startup.command).toContain(input.sessionOptions.model)
  }
)

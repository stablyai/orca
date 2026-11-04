// @vitest-environment happy-dom
import { EVERY_AGENT_CHAT } from '../../../../shared/native-chat/every-agent-chat.test-fixture'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import type { PreparedQuickSubmit } from './composer-submit-model'
import { buildQuickComposerStartup } from './quick-startup-plan'
import { validateActionTerminalArgs } from '@/lib/launch-work-item-direct-messages'
import { useQuickCreationExecution } from './quick-creation-execution'
const background = vi.hoisted(() => vi.fn())
vi.mock('@/lib/worktree-creation-flow', () => ({ runBackgroundWorktreeCreation: background }))
afterEach(() => {
  cleanup()
  background.mockClear()
})

it('carries the accepted route across preparation and retains CLI startup/prompt under chat defaults', async () => {
  const prepared: PreparedQuickSubmit = {
    submitLinkedWorkItem: {
      type: 'issue',
      provider: 'linear',
      number: 0,
      url: '',
      title: 'Typed note'
    },
    agent: 'opencode',
    submitLinkedIssueNumber: null,
    submitLinkedPR: null,
    submitTitleName: null,
    nameIsAutoManaged: false,
    smartGitHubCreateNames: { workspaceName: 'fix', displayName: undefined },
    workspaceName: 'fix',
    nameWasGenerated: false,
    smartSubmitBaseBranch: undefined,
    submitCompareBaseRef: undefined,
    submitPushTarget: undefined,
    submitBranchNameOverride: undefined,
    effectiveSetupDecision: 'skip',
    hookPreparation: undefined,
    linkedLinearIssue: undefined,
    linkedLinearIssueWorkspaceId: undefined,
    linkedLinearIssueOrganizationUrlKey: undefined,
    effectiveBranchNameOverride: 'feature/test',
    branchIntent: 'open-existing-v2',
    submitBaseBranch: undefined,
    createDisplayName: undefined,
    pendingFirstAgentMessageRename: false,
    trimmedNote: 'Fix the checkout'
  }
  const settings = { ...getDefaultSettings('/test'), nativeChatProviders: EVERY_AGENT_CHAT }
  const original = useAppStore.getState().settings
  const prepare = vi.fn<() => Promise<PreparedQuickSubmit | null>>()
  const { result } = renderHook(() =>
    useQuickCreationExecution({
      clearNewWorkspaceDraft: vi.fn(),
      createMultiple: false,
      effectivePresetId: null,
      ephemeralVmRecipes: [],
      ephemeralVmsEnabled: false,
      isSubmissionCancelled: () => false,
      linkedGitLabIssue: null,
      linkedGitLabMR: null,
      normalizedSparseDirectories: [],
      onCreated: vi.fn(),
      parentWorktreeId: null,
      persistDraft: false,
      persistSetupAgentStartupPolicy: async () => true,
      prepareQuickSubmit: prepare,
      resetForNextCreate: vi.fn(),
      resolvedInitialWorkspaceStatus: undefined,
      selectedEphemeralVmRecipeId: null,
      selectedRepoAgentLaunchFact: { kind: 'known', platform: 'darwin', hostKind: 'local' },
      selectedRepoExecutionHostId: 'local',
      selectedRepoIsGit: true,
      selectedRepoIsRemote: false,
      selectedRepoTarget: { kind: 'local' },
      selectedRepoStartupShell: 'posix',
      selectedWorkspaceTarget: { status: 'unavailable', reason: 'no-eligible-repo' },
      settings,
      sparseEnabled: false,
      taskSourceContext: null,
      telemetrySource: undefined
    })
  )
  try {
    for (const route of ['terminal-tui', 'structured-native-chat'] as const) {
      const deferred = Promise.withResolvers<PreparedQuickSubmit>()
      prepare.mockReturnValueOnce(deferred.promise)
      let pending: Promise<void> = Promise.resolve()
      act(() => {
        pending = result.current.executeQuickCreation(
          { kind: 'none' },
          'opencode',
          'fix',
          null,
          'repo-1',
          {
            launchChoice: { agent: 'opencode', route },
            launchInputs: { sessionOptions: { model: 'team-model' }, agentArgs: '--add-dir docs' }
          }
        )
      })
      useAppStore.setState({
        settings: {
          ...settings,
          nativeChatProviders: route === 'terminal-tui' ? EVERY_AGENT_CHAT : {}
        }
      })
      await act(async () => {
        deferred.resolve(prepared)
        await pending
      })
      const request = background.mock.calls.at(-1)?.[0]
      expect(request).toMatchObject({
        agent: 'opencode',
        agentLaunchRoute: route,
        quickPrompt: 'Fix the checkout',
        branchNameOverride: 'feature/test',
        branchIntent: 'open-existing-v2',
        launchInputs: { sessionOptions: { model: 'team-model' }, agentArgs: '--add-dir docs' }
      })
      if (route === 'terminal-tui') {
        expect(request.startup).toMatchObject({
          launchAgent: 'opencode',
          command: expect.stringContaining('opencode')
        })
        expect(request.startup.command).toContain('Fix the checkout')
        expect(request.startup.command).toContain('team-model')
        expect(request.startup.command).toContain('--add-dir')
        expect(request.startup.command).toContain('docs')
      } else {
        expect(request.startup).toBeUndefined()
      }
    }
    for (const linked of [false, true]) {
      prepare.mockResolvedValueOnce({
        ...prepared,
        submitLinkedWorkItem: linked ? prepared.submitLinkedWorkItem : null
      })
      const count = background.mock.calls.length
      await expect(
        result.current.executeQuickCreation({ kind: 'none' }, 'opencode', 'fix', null, 'repo-1', {
          launchChoice: { agent: 'opencode', route: 'terminal-tui' },
          launchInputs: { agentArgs: '--add-dir "docs' }
        })
      ).rejects.toThrow('Could not start OpenCode. Check Arguments in this setup')
      expect(background).toHaveBeenCalledTimes(count)
    }
  } finally {
    useAppStore.setState({ settings: original })
  }
})

it.each(['claude', 'codex'] as const)(
  'keeps %s workspace compiler refusal aligned with tab launches and allows Chat/blank controls',
  (agent) => {
    for (const shell of ['posix', 'powershell'] as const) {
      const input = {
        agent,
        prompt: 'fix',
        draftPrompt: null,
        settings: getDefaultSettings('/test'),
        launchHost: {
          kind: 'known' as const,
          platform: 'darwin' as const,
          hostKind: 'local' as const
        },
        shell,
        isRemote: false,
        telemetrySource: undefined,
        launchInputs: {
          agentArgs: '--add-dir "docs',
          sessionOptions: { model: agent === 'claude' ? 'sonnet' : 'gpt-5.4' }
        }
      }
      expect(validateActionTerminalArgs(agent, input.launchInputs.agentArgs, shell, false)).toBe(
        false
      )
      expect(() => buildQuickComposerStartup(input)).toThrow('Check Arguments in this setup')
      expect(() => buildQuickComposerStartup({ ...input, draftPrompt: 'Linked work' })).toThrow(
        'Check Arguments in this setup'
      )
      expect(() =>
        buildQuickComposerStartup({ ...input, route: 'structured-native-chat' })
      ).not.toThrow()
      expect(buildQuickComposerStartup({ ...input, agent: null }).startupPlan).toBeNull()
      const valid = buildQuickComposerStartup({
        ...input,
        launchInputs: { ...input.launchInputs, agentArgs: '--add-dir docs' }
      })
      expect(valid.startupPlan?.launchCommand).toContain('--add-dir')
      expect(valid.startupPlan?.launchCommand).toContain(input.launchInputs.sessionOptions.model)
      expect(valid.backendStartup?.launchAgent).toBe(agent)
    }
  }
)

import { describe, expect, it, vi } from 'vitest'
import { mocks } from './launch-work-item-direct-test-fixture'
import { launchWorkItemDirect } from './launch-work-item-direct'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { beginDirectWorkItemStructuredLaunch } from '@/lib/launch-work-item-direct-agent-routing'
import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { pickTuiAgent } from '../../../shared/tui-agent-selection'
import type { AppState } from '@/store'

describe('launchWorkItemDirect', () => {
  it('rejects invalid per-launch CLI arguments before creating a workspace', async () => {
    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        agentArgs: '--model "unterminated',
        item: {
          type: 'issue',
          number: 42,
          title: 'Fix invalid saved launch args',
          url: 'https://github.com/acme/repo/issues/42'
        }
      })
    ).resolves.toBe(false)

    expect(mocks.createWorktree).not.toHaveBeenCalled()
    expect(mocks.ensureDetectedAgents).toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'CLI arguments are invalid: Unclosed quote in command template.'
    )
  })

  it('passes a resolved PR branch override while using a short PR identity for workspace names', async () => {
    mocks.ensureDetectedAgents.mockResolvedValue([])
    mocks.store.settings = {}

    await launchWorkItemDirect({
      repoId: 'repo-1',
      launchSource: 'task_page',
      telemetrySource: 'sidebar',
      openModalFallback: vi.fn(),
      item: {
        type: 'pr',
        number: 6934,
        title: 'Fix the bug',
        url: 'https://github.com/stablyai/orca/pull/6934',
        branchName: 'feature/fix',
        baseRefName: 'main',
        isCrossRepository: true
      }
    })

    // Launching from the PR is a user act, so its base read may start a stopped WSL distro.
    expect(mocks.resolvePrBase).toHaveBeenCalledWith({
      repoId: 'repo-1',
      wakeWslDistro: true,
      prNumber: 6934,
      headRefName: 'feature/fix',
      baseRefName: 'main',
      isCrossRepository: true
    })
    expect(mocks.createWorktree).toHaveBeenCalledWith(
      'repo-1',
      'review-pr-6934',
      'abc123',
      'inherit',
      undefined,
      'sidebar',
      'Review PR 6934',
      undefined,
      6934,
      { remoteName: 'origin', branchName: 'feature/fix' },
      undefined,
      undefined,
      'feature/fix',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'refs/remotes/origin/main',
      { executionHostId: 'local' }
    )
  })

  it('treats a PR-typed GitHub issue URL as an issue without resolving a PR head', async () => {
    const openModalFallback = vi.fn()

    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        telemetrySource: 'sidebar',
        openModalFallback,
        item: {
          type: 'pr',
          number: 6933,
          title: 'The board columns are displayed backwards',
          url: 'https://github.com/stablyai/orca/issues/6933',
          branchName: 'fix-issue-6933',
          baseRefName: 'main',
          isCrossRepository: true
        }
      })
    ).resolves.toBe(true)

    expect(mocks.resolvePrBase).not.toHaveBeenCalled()
    expect(openModalFallback).not.toHaveBeenCalled()
    const createArgs = mocks.createWorktree.mock.calls[0]
    expect(createArgs?.[1]).toBe('issue-6933')
    expect(createArgs?.[2]).toBeUndefined()
    expect(createArgs?.[6]).toBe('Issue 6933')
    expect(createArgs?.[7]).toBe(6933)
    expect(createArgs?.[8]).toBeUndefined()
    expect(createArgs?.[9]).toBeUndefined()
    expect(createArgs?.[12]).toBeUndefined()
    expect(createArgs?.[24]).toBeUndefined()
  })

  it('uses the Linear identifier in direct-launch workspace names', async () => {
    await launchWorkItemDirect({
      repoId: 'repo-1',
      launchSource: 'task_page',
      telemetrySource: 'sidebar',
      openModalFallback: vi.fn(),
      item: {
        type: 'issue',
        number: null,
        title: 'Ship Linear parity',
        url: 'https://linear.app/acme/issue/ENG-42/ship-linear-parity',
        linearIdentifier: 'ENG-42'
      }
    })

    expect(mocks.createWorktree).toHaveBeenCalledWith(
      'repo-1',
      'eng-42-ship-linear-parity',
      undefined,
      'inherit',
      undefined,
      'sidebar',
      'Ship Linear parity',
      undefined,
      undefined,
      undefined,
      undefined,
      'ENG-42',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { executionHostId: 'local' }
    )
  })

  it('prefills a link-only Linear reference without source context', async () => {
    mocks.ensureDetectedAgents.mockResolvedValue(['claude'])

    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        agentOverride: 'claude',
        item: {
          type: 'issue',
          number: null,
          title: 'Ship Linear parity',
          url: 'https://linear.app/acme/issue/ENG-42/ship-linear-parity',
          linearIdentifier: 'ENG-42',
          linkedContext: {
            provider: 'linear',
            version: 1,
            renderedText: [
              'Linear issue context snapshot',
              'Identifier: ENG-42',
              'Title: Ship Linear parity',
              'Description:',
              'The distinctive Linear body text is here.'
            ].join('\n')
          }
        }
      })
    ).resolves.toBe(true)

    const expectedDraft = [
      'Linked Linear issue: ENG-42',
      'https://linear.app/acme/issue/ENG-42/ship-linear-parity'
    ].join('\n')
    expect(buildAgentDraftLaunchPlan).toHaveBeenCalledWith({
      agent: 'claude',
      draft: `${expectedDraft}\n`,
      cmdOverrides: {},
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: {},
      platform: 'win32',
      shell: 'powershell',
      isRemote: false
    })
    expect(buildAgentStartupPlan).not.toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'claude',
        prompt: '',
        allowEmptyPromptLaunch: true
      })
    )
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(
      'repo-1::/repo/worktree',
      expect.objectContaining({
        startup: expect.objectContaining({
          command: expect.stringContaining('Linked Linear issue: ENG-42')
        })
      })
    )
    const startupCommand = mocks.activateAndRevealWorktree.mock.calls[0]?.[1]?.startup?.command
    expect(startupCommand).toContain('https://linear.app/acme/issue/ENG-42/ship-linear-parity')
    expect(startupCommand).not.toContain('The distinctive Linear body text is here.')
    expect(startupCommand).not.toContain('--- BEGIN LINKED WORK ITEM CONTEXT ---')
    expect(pasteDraftWhenAgentReady).not.toHaveBeenCalled()
  })

  it('seeds the chat-composer launch draft for a GitHub issue draft launch', async () => {
    mocks.ensureDetectedAgents.mockResolvedValue(['claude'])
    mocks.store.settings = { defaultTuiAgent: 'codex', disabledTuiAgents: ['claude'] }

    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        agentOverride: 'claude',
        agentLaunchPreferences: { defaultTuiAgent: 'claude', disabledTuiAgents: undefined },
        item: {
          type: 'issue',
          number: 12,
          title: 'Fix crash on launch',
          url: 'https://github.com/acme/repo/issues/12'
        }
      })
    ).resolves.toBe(true)

    // Mirror argv prefill into chat because no paste callback can expose that TUI-only context.
    expect(mocks.seedNativeChatLaunchDraft).toHaveBeenCalledWith({
      tabId: 'tab-1',
      agent: 'claude',
      text: 'https://github.com/acme/repo/issues/12',
      createdAt: expect.any(Number)
    })
    expect(mocks.seedNativeChatLaunchPrompt).not.toHaveBeenCalled()
    const startup = mocks.activateAndRevealWorktree.mock.calls.at(-1)?.[1]?.startup
    expect(startup?.draftPrompt).toBeUndefined()
  })

  it('seeds the chat-composer launch draft for a multi-line Linear draft launch', async () => {
    // Linear drafts always contain newlines; rejecting multiline mirrors would hide every linked issue in chat.
    mocks.ensureDetectedAgents.mockResolvedValue(['claude'])

    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        agentOverride: 'claude',
        item: {
          type: 'issue',
          number: null,
          title: 'Ship Linear parity',
          url: 'https://linear.app/acme/issue/ENG-42/ship-linear-parity',
          linearIdentifier: 'ENG-42'
        }
      })
    ).resolves.toBe(true)

    expect(mocks.seedNativeChatLaunchDraft).toHaveBeenCalledWith({
      tabId: 'tab-1',
      agent: 'claude',
      text: 'Linked Linear issue: ENG-42\nhttps://linear.app/acme/issue/ENG-42/ship-linear-parity\n',
      createdAt: expect.any(Number)
    })
  })

  it('preserves explicit Linear paste content submit-after-ready behavior', async () => {
    mocks.ensureDetectedAgents.mockResolvedValue(['claude'])

    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        agentOverride: 'claude',
        promptDelivery: 'submit-after-ready',
        item: {
          type: 'issue',
          number: null,
          title: 'Ship Linear parity',
          url: 'https://linear.app/acme/issue/ENG-42/ship-linear-parity',
          linearIdentifier: 'ENG-42',
          pasteContent: 'Use this explicit user prompt.',
          linkedContext: {
            provider: 'linear',
            version: 1,
            renderedText: 'This generated Linear source should not replace explicit paste content.'
          }
        }
      })
    ).resolves.toBe(true)

    expect(buildAgentDraftLaunchPlan).not.toHaveBeenCalled()
    expect(pasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-1',
        content: 'Use this explicit user prompt.',
        agent: 'claude',
        submit: true,
        forcePaste: true,
        onTimeout: expect.any(Function)
      })
    )
    expect(mocks.seedNativeChatLaunchPrompt).toHaveBeenCalledWith({
      tabId: 'tab-1',
      agent: 'claude',
      text: 'Use this explicit user prompt.',
      createdAt: expect.any(Number)
    })
    expect(mocks.seedNativeChatLaunchDraft).not.toHaveBeenCalled()
  })

  it('reports a failed structured settlement instead of pasting into the pre-launch tab', async () => {
    mocks.ensureDetectedAgents.mockResolvedValue(['claude'])
    // A failed chat must not paste PR text into the seeded shell or report success that callers use to authorize follow-up work.
    vi.mocked(beginDirectWorkItemStructuredLaunch).mockReturnValueOnce({
      completed: false,
      structuredLaunch: true,
      primaryTabId: null
    })

    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        agentOverride: 'claude',
        promptDelivery: 'submit-after-ready',
        item: {
          type: 'pr',
          number: 7,
          title: 'Review this PR',
          url: 'https://github.com/acme/repo/pull/7',
          pasteContent: 'rm -rf ./build\nReview the PR body.'
        }
      })
    ).resolves.toBe(false)

    expect(beginDirectWorkItemStructuredLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ primaryTabId: null, beforeOpen: expect.any(Function) })
    )
    expect(pasteDraftWhenAgentReady).not.toHaveBeenCalled()
    expect(mocks.seedNativeChatLaunchPrompt).not.toHaveBeenCalled()
    expect(mocks.seedNativeChatLaunchDraft).not.toHaveBeenCalled()
  })

  // A paired server that declines the chat opens this launch's terminal, which must keep the
  // recipe's saved CLI arguments the terminal route applied.
  it.each([undefined, '', '--model opus'])(
    "hands a server's decline terminal the caller's own CLI arguments (%s)",
    async (agentArgs) => {
      mocks.ensureDetectedAgents.mockResolvedValue(['claude'])
      vi.mocked(beginDirectWorkItemStructuredLaunch).mockReturnValueOnce({
        completed: true,
        structuredLaunch: true,
        primaryTabId: null
      })

      await launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        agentOverride: 'claude',
        ...(agentArgs !== undefined ? { agentArgs } : {}),
        ...(agentArgs ? { resolveAgentArgs: () => `--verbose ${agentArgs}` } : {}),
        launchPlatform: 'linux',
        promptDelivery: 'submit-after-ready',
        item: {
          type: 'pr',
          number: 7,
          title: 'Fix checks',
          url: 'https://github.com/acme/repo/pull/7',
          pasteContent: 'Fix the failing checks.'
        }
      })

      expect(beginDirectWorkItemStructuredLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          declinedTerminal: {
            ...(agentArgs !== undefined
              ? { agentArgs: agentArgs ? `--verbose ${agentArgs}` : agentArgs }
              : {}),
            launchPlatform: 'linux',
            launchSource: 'task_page'
          }
        })
      )
    }
  )

  it('uses remote cursor-agent detection and paste launch for SSH repos', async () => {
    mocks.store.repos = [
      {
        id: 'repo-ssh',
        path: '/home/orca/repo',
        displayName: 'Remote Repo',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: 'ssh-1'
      }
    ] as AppState['repos']
    mocks.store.settings = { defaultTuiAgent: 'cursor' } as AppState['settings']
    mocks.store.ensureRemoteDetectedAgents.mockResolvedValue(['cursor'])
    vi.mocked(pickTuiAgent).mockReturnValueOnce('cursor')
    vi.mocked(buildAgentDraftLaunchPlan).mockReturnValueOnce(null)
    vi.mocked(buildAgentStartupPlan).mockReturnValueOnce({
      agent: 'cursor',
      launchCommand: 'cursor-agent',
      expectedProcess: 'cursor-agent',
      followupPrompt: null,
      launchConfig: { agentArgs: '', agentEnv: {} }
    })
    mocks.store.createWorktree.mockResolvedValue({
      worktree: { id: 'wt-ssh', path: '/home/orca/repo-worktrees/issue-77' }
    })

    await launchWorkItemDirect({
      repoId: 'repo-ssh',
      launchSource: 'task_page',
      telemetrySource: 'sidebar',
      openModalFallback: vi.fn(),
      item: {
        type: 'issue',
        number: 77,
        title: 'Fix cursor direct launch',
        url: 'https://github.com/acme/repo/issues/77'
      }
    })

    expect(mocks.store.ensureDetectedAgents).not.toHaveBeenCalled()
    expect(mocks.store.ensureRemoteDetectedAgents).toHaveBeenCalledWith('ssh-1')
    expect(buildAgentDraftLaunchPlan).toHaveBeenCalledWith({
      agent: 'cursor',
      draft: 'https://github.com/acme/repo/issues/77',
      cmdOverrides: {},
      agentArgs: '--yolo',
      agentEnv: {},
      platform: 'linux',
      isRemote: true
    })
    expect(buildAgentStartupPlan).toHaveBeenCalledWith({
      agent: 'cursor',
      prompt: '',
      cmdOverrides: {},
      agentArgs: '--yolo',
      agentEnv: {},
      platform: 'linux',
      isRemote: true,
      allowEmptyPromptLaunch: true
    })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(
      'wt-ssh',
      expect.objectContaining({
        startup: expect.objectContaining({
          draftPrompt: 'https://github.com/acme/repo/issues/77'
        })
      })
    )
    expect(pasteDraftWhenAgentReady).not.toHaveBeenCalled()
  })

  it.each(['desktop', 'disabled', 'missing'])('rejects saved agent: %s', async (kind) => {
    mocks.ensureDetectedAgents.mockResolvedValue(
      kind === 'missing' ? ['claude'] : ['codex', 'claude']
    )
    mocks.store.settings = {
      defaultTuiAgent: 'claude',
      disabledTuiAgents: ['codex'],
      agentCmdOverrides: {}
    }

    await expect(
      launchWorkItemDirect({
        item: {
          title: 'Fix failing checks',
          url: 'https://github.com/acme/repo/pull/1',
          type: 'issue',
          number: 1,
          pasteContent: 'Fix the failing checks.'
        },
        repoId: 'repo-1',
        openModalFallback: mocks.openModalFallback,
        launchSource: 'task_page',
        agentOverride: 'codex',
        agentLaunchPreferences:
          kind === 'desktop'
            ? undefined
            : { defaultTuiAgent: 'codex', disabledTuiAgents: kind === 'disabled' ? ['codex'] : [] },
        promptDelivery: 'submit-after-ready'
      })
    ).resolves.toBe(false)

    expect(mocks.createWorktree).toHaveBeenCalledTimes(kind === 'disabled' ? 0 : 1)
    expect(mocks.updateWorktreeMeta).not.toHaveBeenCalled()
    expect(mocks.pasteDraftWhenAgentReady).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Selected agent is not available in the created workspace.'
    )
  })

  it('plans direct SSH workspace agent startup for the remote host platform', async () => {
    mocks.getConnectionId.mockReturnValue('ssh-1')
    mocks.ensureRemoteDetectedAgents.mockResolvedValue(['pi'])
    mocks.store.repos = [
      {
        id: 'repo-1',
        path: '/home/alice/repo',
        connectionId: 'ssh-1',
        displayName: 'Remote Repo',
        addedAt: 1
      }
    ]

    await expect(
      launchWorkItemDirect({
        item: {
          title: 'Fix failing checks',
          url: 'https://github.com/acme/repo/pull/1',
          type: 'issue',
          number: 1,
          pasteContent: 'Fix the failing checks.'
        },
        repoId: 'repo-1',
        openModalFallback: mocks.openModalFallback,
        launchSource: 'task_page',
        agentOverride: 'pi'
      })
    ).resolves.toBe(true)

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalled()
    const activationOptions = mocks.activateAndRevealWorktree.mock.calls.at(-1)?.[1]
    expect(activationOptions.startup.command).toContain(
      `command test -n "$fish_pid" && set --erase -g ORCA_PI_PREFILL; command test -z "$fish_pid" && unset ORCA_PI_PREFILL; true`
    )
    expect(activationOptions.startup.command).not.toContain('Remove-Item Env:ORCA_PI_PREFILL')
  })

  it('uses the repo SSH connection when the created worktree is not hydrated yet', async () => {
    mocks.getConnectionId.mockReturnValue(undefined)
    mocks.ensureRemoteDetectedAgents.mockResolvedValue(['pi'])
    mocks.store.settings = {
      defaultTuiAgent: 'pi',
      disabledTuiAgents: [],
      agentCmdOverrides: {}
    }
    mocks.store.repos = [
      {
        id: 'repo-1',
        path: '/home/alice/repo',
        connectionId: 'ssh-1',
        displayName: 'Remote Repo',
        addedAt: 1
      }
    ]

    await expect(
      launchWorkItemDirect({
        item: {
          title: 'Fix failing checks',
          url: 'https://github.com/acme/repo/pull/1',
          type: 'issue',
          number: 1,
          pasteContent: 'Fix the failing checks.'
        },
        repoId: 'repo-1',
        openModalFallback: mocks.openModalFallback,
        launchSource: 'task_page'
      })
    ).resolves.toBe(true)

    expect(mocks.ensureRemoteDetectedAgents).toHaveBeenCalledWith('ssh-1')
    expect(mocks.ensureDetectedAgents).not.toHaveBeenCalled()
    const activationOptions = mocks.activateAndRevealWorktree.mock.calls.at(-1)?.[1]
    expect(activationOptions.startup.command).toContain(
      `command test -n "$fish_pid" && set --erase -g ORCA_PI_PREFILL; command test -z "$fish_pid" && unset ORCA_PI_PREFILL; true`
    )
  })
})

import { nonRefusedAgentLaunch } from '@/lib/agent-session/launch/new-tab/agent-tab-launch-outcome.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mockCreateTab,
  mockSetActiveTabType,
  mockToastError,
  queuedStartups,
  mockSetAgentStatus,
  mockPasteDraftWhenAgentReady,
  LEAF_ID,
  store,
  mockCreateWebRuntimeSessionTerminal,
  mockIsWebRuntimeSessionActive,
  COMMAND_CODE_CLICK
} from './launch-agent-in-new-tab-test-fixture'
import { toAppSshPtyId } from '../../../../../../shared/ssh-pty-id'

import { projectSourceControlActionLaunch } from '../../../../../../shared/source-control/ai/recipes/source-control-action-launch-preferences'
import { planAgentSessionLaunch } from '../routing/agent-session-launch-plan'
import { openDeclinedTerminal } from '../structured-agent-session-action-launch'
import { tokenizeStartupCommand } from '../../../../../../shared/agent-launch/startup/tui-agent-startup-shell'

afterEach(() => {
  vi.restoreAllMocks()
  Object.assign(store, { activeWorkspaceExecutionHostId: null })
})

describe('launchAgentInNewTab', () => {
  it('carries section trust ownership only in the transient pending startup', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    launchAgentInNewTab({
      requestId: 'section-trust-test',
      agent: 'claude',
      worktreeId: 'wt-1',
      requestedSurface: 'terminal',
      initialCwd: '/outside/section',
      trustWorktreeId: 'repo::/outside/section',
      prompt: 'Resolve conflicts',
      promptDelivery: 'auto-submit'
    })
    expect(queuedStartups()[0]).toMatchObject({
      trustWorktreeId: 'repo::/outside/section',
      launchAgent: 'claude'
    })
    expect(mockCreateTab.mock.calls[0][0]).toBe('wt-1')
    expect(mockCreateTab.mock.calls[0][3]).not.toHaveProperty('trustWorktreeId')
    expect(mockCreateTab.mock.calls[0][3]?.startupCwd).toBe('/outside/section')
  })

  it.each(['created', 'failed'] as const)(
    'settles a %s requested host agent beside existing surfaces using its captured owner',
    async (creation) => {
      const { launchAgentInNewTabWithOutcome } = await import('./launch-agent-in-new-tab')
      const { settleAgentTabLaunch } = await import('./launch-agent-in-new-tab-host-agents')
      store.settings.nativeChatProviders = { claude: true }
      Object.assign(store, {
        activeWorkspaceExecutionHostId: 'runtime:web-runtime',
        activeTabId: 'shell'
      })
      store.tabsByWorktree['wt-1'] = [
        { id: 'shell' },
        Object.assign({ id: 'live-claude' }, { launchAgent: 'claude' })
      ]
      const hostStatus = {
        status: {
          hostPlatform: 'linux',
          capabilities: []
        }
      }
      store.runtimeStatusByEnvironmentId.set('web-runtime', hostStatus)
      Object.assign(store.repos[0], { executionHostId: 'runtime:web-runtime' })
      Object.assign(store.worktreesByRepo['repo-1'][0], { hostId: 'runtime:web-runtime' })
      mockIsWebRuntimeSessionActive.mockReturnValue(true)
      const reveal = vi.fn(() => true)
      if (creation === 'failed') {
        mockCreateWebRuntimeSessionTerminal.mockResolvedValueOnce({
          status: 'failed',
          message: 'host disconnected'
        })
      }
      const result = launchAgentInNewTabWithOutcome({
        requestId: 'captured-owner',
        agent: 'claude',
        worktreeId: 'wt-1',
        workspaceExecutionHostId: 'runtime:web-runtime',
        beforeSurfaceOpen: reveal,
        launchSource: 'onboarding'
      })
      expect(result && !('refused' in result) && result.terminalCompletion).toBeDefined()
      Object.assign(store, {
        activeWorktreeId: 'different-workspace',
        activeWorkspaceExecutionHostId: 'runtime:other'
      })
      await expect(settleAgentTabLaunch(result)).resolves.toEqual(
        creation === 'created' ? { kind: 'terminal' } : { kind: 'cancelled', sessionId: null }
      )
      expect(mockToastError).toHaveBeenCalledTimes(creation === 'failed' ? 1 : 0)
      expect(reveal).toHaveBeenCalledOnce()
      expect(mockCreateWebRuntimeSessionTerminal).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          worktreeId: 'wt-1',
          environmentId: 'web-runtime',
          launchAgent: 'claude',
          activate: true
        })
      )
      expect(reveal.mock.invocationCallOrder[0]).toBeLessThan(
        mockCreateWebRuntimeSessionTerminal.mock.invocationCallOrder[0]
      )
      if (creation === 'created') {
        expect(mockSetActiveTabType).toHaveBeenCalledExactlyOnceWith('terminal', 'wt-1')
      } else {
        expect(mockSetActiveTabType).not.toHaveBeenCalled()
      }
      expect(mockCreateTab).not.toHaveBeenCalled()
    }
  )

  it.each(['context', 'command', 'unexpected'] as const)(
    'reports one notifying launch failure for %s',
    async (failure) => {
      const { launchAgentInNewTabWithOutcome } = await import('./launch-agent-in-new-tab')
      if (failure === 'context') {
        Object.assign(store, { activeWorkspaceExecutionHostId: 'runtime:unanswered' })
      } else {
        const startup = await import('../prompt/launch-agent-startup-prompt-plan')
        const planner = vi.spyOn(startup, 'planLaunchAgentStartupPrompt')
        if (failure === 'command') {
          planner.mockReturnValue({
            startupPlan: null,
            pasteDraftAfterLaunch: null,
            submitPastedPrompt: false
          })
        } else {
          planner.mockImplementation(() => {
            throw new Error('unexpected')
          })
        }
      }
      const result = launchAgentInNewTabWithOutcome({
        requestId: 'failed',
        agent: 'claude',
        worktreeId: 'wt-1',
        requestedSurface: 'terminal'
      })
      expect(result).toEqual({ refused: { delivered: false, failureNotified: true } })
      expect(mockToastError).toHaveBeenCalledOnce()
      expect(mockCreateTab).not.toHaveBeenCalled()
    }
  )

  it.each(['terminal', 'declined-without-callback'] as const)(
    'keeps canonical saved source and deliberate effort through actual %s startup',
    async (route) => {
      store.settings.agentCmdOverrides = { codex: 'cx' }
      const projection = projectSourceControlActionLaunch(
        {
          agentId: 'codex',
          agentArgs: `-c 'model="true"'`,
          launchPreferences: {
            agentId: 'codex',
            modelSelection: {
              base: 'default',
              options: { effort: { agentId: 'codex', value: 'high' } }
            }
          }
        },
        'codex',
        { basePrompt: 'Fix checks' }
      )
      expect(projection.agentArgs).toBe(`-c 'model="true"'`)
      expect(projection.sessionOptions).toEqual({ effort: 'high' })
      expect(projection.chatSessionOptions).toEqual({ model: 'true', effort: 'high' })
      const { useAppStore } = await import('@/store/index')
      const plan = planAgentSessionLaunch(useAppStore.getState(), {
        requestId: 'saved-source-fallback',
        agent: 'codex',
        workspace: { kind: 'git-worktree', worktreeId: 'wt-1' },
        requestedSurface: 'terminal',
        launchOptions: projection.sessionOptions,
        chatLaunchOptions: projection.chatSessionOptions
      })
      expect(plan.route).toBe('terminal-tui')
      if (route === 'terminal') {
        const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
        launchAgentInNewTab({
          agent: 'codex',
          worktreeId: 'wt-1',
          launchPlatform: 'linux',
          ...projection,
          agentSessionLaunchPlan: plan
        })
      } else {
        // Exercise the actual default decline path, with no caller terminal callback.
        const terminal = await openDeclinedTerminal(
          {
            plan,
            hooks: {},
            declinedTerminal: {
              agentArgs: projection.agentArgs,
              launchPlatform: 'linux'
            }
          },
          'wt-1',
          { kind: 'local' }
        )
        expect(terminal.opened).toBe(true)
      }
      const startup = queuedStartups()[0]
      expect(startup).toBeDefined()
      expect(tokenizeStartupCommand(startup.command ?? '', 'posix')).toMatchObject({
        ok: true,
        tokens: ['cx', '-c', 'model="true"', '-c', 'model_reasoning_effort=high']
      })
      expect(startup.launchConfig?.agentArgs).toBe(`-c 'model="true"'`)
      expect(startup.launchConfig).not.toHaveProperty('chatSessionOptions')
      expect(startup.launchConfig).not.toHaveProperty('chatLaunchOptions')
    }
  )

  it('falls back to post-ready draft paste when a Windows inline draft would be too large', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const prompt = 'x'.repeat(25_000)

    const result = nonRefusedAgentLaunch(
      launchAgentInNewTab({
        requestId: 'request-17',
        agent: 'claude',
        worktreeId: 'wt-1',
        prompt,
        promptDelivery: 'draft',
        launchPlatform: 'win32'
      })
    )

    expect(result?.promptDeliveryResult).toBeDefined()
    expect(queuedStartups()).toContainEqual(
      expect.objectContaining({
        command: "claude '--dangerously-skip-permissions'"
      })
    )
    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-1',
        content: prompt,
        agent: 'claude',
        submit: false,
        forcePaste: true
      })
    )
  })

  it('does not recreate SSH status when clear arrives before disconnect state', async () => {
    let finishDelivery: ((delivered: boolean) => void) | undefined
    mockPasteDraftWhenAgentReady.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finishDelivery = resolve
      })
    )
    store.repos = [{ id: 'repo-1', connectionId: 'ssh-a', path: '/repo' }]
    const ptyId = toAppSshPtyId('ssh-a', 'pty-1')
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = nonRefusedAgentLaunch(
      launchAgentInNewTab({
        ...COMMAND_CODE_CLICK,
        prompt: 'pending prompt',
        promptDelivery: 'submit-after-ready'
      })
    )
    store.terminalLayoutsByTabId = {
      'tab-1': { activeLeafId: LEAF_ID, ptyIdsByLeafId: { [LEAF_ID]: ptyId } }
    }
    store.ptyIdsByTabId = { 'tab-1': [ptyId] }

    // Disconnect clears status before the state event, while the old binding can still appear connected.
    store.transientClearedAgentStatusConnectionIds = { 'ssh-a': true }
    finishDelivery?.(true)
    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })

    expect(mockSetAgentStatus).not.toHaveBeenCalled()
  })
})

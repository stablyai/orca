import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mockCreateTab,
  queuedStartups,
  mockSetAgentStatus,
  mockPasteDraftWhenAgentReady,
  LEAF_ID,
  store,
  mockCreateWebRuntimeSessionTerminal,
  mockIsWebRuntimeSessionActive,
  COMMAND_CODE_CLICK
} from './launch-agent-in-new-tab-test-fixture'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'

import { projectSourceControlActionLaunch } from '../../../shared/source-control-action-launch-preferences'
import { planAgentSessionLaunch } from './agent-session-launch-plan'
import { openDeclinedTerminal } from './agent-session/launch/structured-agent-session-action-launch'
import { tokenizeStartupCommand } from '../../../shared/tui-agent-startup-shell'

afterEach(() => vi.restoreAllMocks())

describe('launchAgentInNewTab', () => {
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
      const { useAppStore } = await import('@/store')
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
      expect(tokenizeStartupCommand(startup.command, 'posix')).toMatchObject({
        ok: true,
        tokens: ['cx', '-c', 'model="true"', '-c', 'model_reasoning_effort=high']
      })
      expect(startup.launchConfig?.agentArgs).toBe(`-c 'model="true"'`)
      expect(startup.launchConfig).not.toHaveProperty('chatSessionOptions')
      expect(startup.launchConfig).not.toHaveProperty('chatLaunchOptions')
    }
  )

  it.each(['local', 'ssh', 'capable-web', 'older-web'] as const)(
    'keeps the whole saved-source terminal DTO/config identical to its base-only caller on %s',
    async (host) => {
      const transport = await import('../components/settings/agent-launch-settings-transport')
      const preferences = await import('../components/settings/use-host-agent-launch-preferences')
      vi.spyOn(transport, 'hostSupportsLaunchChoices').mockResolvedValue(host === 'capable-web')
      vi.spyOn(preferences, 'ensureAgentLaunchPreferences').mockResolvedValue({
        defaultTuiAgent: 'codex',
        disabledTuiAgents: undefined,
        agentLaunchChoices: {}
      })
      store.settings.agentCmdOverrides = { codex: 'cx' }
      if (host === 'ssh') {
        store.repos[0].connectionId = 'ssh-target-1'
      }
      mockIsWebRuntimeSessionActive.mockReturnValue(host.endsWith('web'))
      if (host.endsWith('web')) {
        store.settings.activeRuntimeEnvironmentId = 'web-runtime'
        Object.assign(store.repos[0], { executionHostId: 'runtime:web-runtime' })
      }
      const raw = `-c 'model="true"'  --search`
      const projection = projectSourceControlActionLaunch(
        {
          agentArgs: raw,
          launchPreferences: {
            agentId: 'codex',
            modelSelection: {
              base: 'default',
              options: { effort: { agentId: 'codex', value: 'high' } }
            }
          }
        },
        'codex',
        { basePrompt: '' }
      )
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
      const perform = async (
        input: Partial<
          Extract<Parameters<typeof launchAgentInNewTab>[0], { agentSessionLaunchPlan?: undefined }>
        >
      ) => {
        mockCreateTab.mockClear()
        mockCreateWebRuntimeSessionTerminal.mockClear()
        const result = launchAgentInNewTab({
          requestId: 'source-parity',
          agent: 'codex',
          worktreeId: 'wt-1',
          requestedSurface: 'terminal',
          launchPlatform: 'linux',
          ...input
        })
        await result?.terminalCompletion
        return {
          startup: queuedStartups()[0],
          wire: mockCreateWebRuntimeSessionTerminal.mock.calls[0]?.[0],
          surface: result?.surface
        }
      }
      const expected = await perform({ agentArgs: raw, sessionOptions: { effort: 'high' } })
      const actual = await perform(projection)
      expect(actual).toEqual(expected)
      const payload = actual.wire ?? actual.startup
      expect(payload).toBeDefined()
      expect(payload?.launchConfig?.agentArgs).toBe(raw)
      expect(JSON.stringify(payload)).not.toContain('chatSessionOptions')
      expect(JSON.stringify(payload)).not.toContain('chatLaunchOptions')
      expect(payload?.command).toContain('model_reasoning_effort=high')
      expect(payload?.command).toContain('model="true"')
      if (actual.wire) {
        expect(transport.hostSupportsLaunchChoices).toHaveBeenCalledWith({
          environmentId: 'web-runtime'
        })
        expect(actual.wire.launchPreferences).not.toHaveProperty('model')
        expect(actual.wire.agentArgs).toBe(raw)
      }
    }
  )

  it('falls back to post-ready draft paste when a Windows inline draft would be too large', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const prompt = 'x'.repeat(25_000)

    const result = launchAgentInNewTab({
      requestId: 'request-17',
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt,
      promptDelivery: 'draft',
      launchPlatform: 'win32'
    })

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

    const result = launchAgentInNewTab({
      ...COMMAND_CODE_CLICK,
      prompt: 'pending prompt',
      promptDelivery: 'submit-after-ready'
    })
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

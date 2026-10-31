// @vitest-environment happy-dom
import { EVERY_AGENT_CHAT } from '../../src/shared/native-chat/every-agent-chat.test-fixture'
import { mocks, store } from './launch-agent-web-terminal.test-fixture'
import { createElement, useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useTabAgentMenuLaunch } from '@/components/tab-bar/QuickLaunchButton'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../src/shared/protocol-version'
import { AGENT_SESSION_AGENTS_METHOD } from '../../src/shared/agent-session/agent-session-registered-agents'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { newAgentPromptOutcome } from '@/lib/new-agent-prompt-outcome'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { stubRuntimeEnvironmentBridge } from '@/runtime/runtime-environment-bridge-fixture'
import { AGENT_LAUNCH_CHOICES_CAPABILITY } from '../../src/shared/agent-launch-runtime-capability'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { consumeOldHostPreparedCommand } from './prepared-action-launch.test-fixture'
import { clearHostAgentMenuSettingsForTests } from '@/components/settings/use-host-agent-launch-preferences'
import { projectAgentLaunchSettings } from '../../src/shared/agent-launch-settings'
import { describe, expect, it, vi } from 'vitest'

describe('launchAgentInNewTab paired web runtime', () => {
  it.each([true, false, 'failed'] as const)('delegates agent quick launch (%s)', async (mode) => {
    store.settings.agentDefaultArgs = { claude: '--model "model with spaces"' }
    const activate = mode === true
    const status = mode === 'failed' ? 'failed' : 'created'
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({
      outcome: {
        status,
        ...(status === 'failed' ? { message: 'The host refused the launch.' } : {})
      },
      hostTabId: 'host-tab::leaf-1'
    })
    store.tabsByWorktree['wt-1'].push({ id: 'local-agent-tab', launchAgent: 'claude' })
    const { launchAgentInNewTab } =
      await import('../../src/renderer/src/lib/launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-1',
      activate,
      agent: 'claude',
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(result).toEqual(
      expect.objectContaining({
        surface: { kind: 'host-published' },
        pasteDraftAfterLaunch: false
      })
    )
    await result?.terminalCompletion
    const startupPlan = mocks.createWebRuntimeSessionTerminal.mock.calls[0][0]
    expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'web-runtime',
      targetGroupId: 'group-1',
      activate,
      ...(activate ? {} : { selectWorktree: false }),
      agentSessionKind: 'fresh',
      launchAgent: 'claude',
      preparedAgentCommand: false,
      command: startupPlan.command,
      env: startupPlan.env,
      launchConfig: startupPlan.launchConfig,
      viewMode: 'terminal'
    })
    expect(startupPlan.launchConfig.agentArgs).toBe(store.settings.agentDefaultArgs.claude)
    expect(mocks.createTab).not.toHaveBeenCalled()
    await expect(result?.terminalCompletion).resolves.toMatchObject({
      outcome: { status },
      ...(status === 'created' ? { tabId: 'web-terminal-host-tab' } : {})
    })
    expect(mocks.setActiveTabType).toHaveBeenCalledTimes(activate && status === 'created' ? 1 : 0)
    expect(mocks.toastError).toHaveBeenCalledTimes(status === 'failed' ? 1 : 0)
    if (status === 'failed') {
      expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(/Claude.*Check the workspace connection/)
      )
    }
    // A local tab closes locally (the host close no-ops), so a launch leaves it alone.
    expect(mocks.closeTab).not.toHaveBeenCalled()
  })

  it('awaits the capable host map once and preserves explicit/raw and prepared command ownership', async () => {
    mocks.capability.mockResolvedValue(true)
    store.settings.agentLaunchChoices = { claude: { model: 'sonnet', options: { effort: 'low' } } }
    store.settings.agentDefaultArgs = { claude: '--verbose' }
    store.settings.agentDefaultEnv = { claude: { KEEP: 'caller' } }
    const pending = Promise.withResolvers<{
      settings: ReturnType<typeof projectAgentLaunchSettings>
    }>()
    mocks.hostRpc.mockReturnValueOnce(pending.promise)
    const { launchAgentInNewTab } =
      await import('../../src/renderer/src/lib/launch-agent-in-new-tab')
    const result = launchAgentInNewTab({
      requestId: newAgentLaunchRequestId(),
      agent: 'claude',
      worktreeId: 'wt-1',
      requestedSurface: 'terminal'
    })
    expect(mocks.createWebRuntimeSessionTerminal).not.toHaveBeenCalled()
    pending.resolve({
      settings: projectAgentLaunchSettings({
        agentLaunchChoices: { claude: { model: 'opus', options: { effort: 'high' } } }
      })
    })
    await result?.terminalCompletion
    expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledTimes(1)
    expect(mocks.createWebRuntimeSessionTerminal.mock.calls[0][0]).toMatchObject({
      command: expect.stringContaining("'opus'"),
      env: { KEEP: 'caller' },
      launchConfig: { agentArgs: '--verbose' },
      preparedAgentCommand: false
    })
    expect(mocks.createWebRuntimeSessionTerminal.mock.calls[0][0]).not.toHaveProperty(
      'launchPreferences'
    )
    mocks.createWebRuntimeSessionTerminal.mockClear()
    const picked = launchAgentInNewTab({
      requestId: newAgentLaunchRequestId(),
      agent: 'claude',
      worktreeId: 'wt-1',
      requestedSurface: 'terminal',
      agentArgs: '--model literal',
      sessionOptions: { model: 'picked' }
    })
    await picked?.terminalCompletion
    expect(mocks.createWebRuntimeSessionTerminal.mock.calls[0][0]).toMatchObject({
      command: expect.stringContaining("'picked'"),
      agentArgs: '--model literal',
      launchPreferences: { model: 'picked' },
      launchConfig: { agentArgs: '' }
    })
    clearHostAgentMenuSettingsForTests()
    mocks.hostRpc.mockResolvedValue({
      settings: projectAgentLaunchSettings({
        agentLaunchChoices: { claude: { options: { effort: 'high' } } }
      })
    })
    store.settings.agentCmdOverrides = { claude: 'cx' }
    const prepared = launchAgentInNewTab({
      requestId: newAgentLaunchRequestId(),
      agent: 'claude',
      worktreeId: 'wt-1',
      requestedSurface: 'terminal'
    })
    await prepared?.terminalCompletion
    expect(mocks.createWebRuntimeSessionTerminal.mock.calls.at(-1)?.[0]).toMatchObject({
      command: "cx '--verbose' '--effort' 'high'",
      env: { KEEP: 'caller' },
      preparedAgentCommand: true,
      launchConfig: { agentCommand: "cx '--verbose'", agentArgs: '--verbose' }
    })
    expect(mocks.createTab).not.toHaveBeenCalled()
    const dispatched = mocks.createWebRuntimeSessionTerminal.mock.calls.length
    store.settings.agentCmdOverrides = { claude: 'claude --model sonnet' }
    const refused = launchAgentInNewTab({
      requestId: newAgentLaunchRequestId(),
      agent: 'claude',
      worktreeId: 'wt-1',
      requestedSurface: 'terminal',
      prompt: 'keep this prompt',
      sessionOptions: { model: 'opus' }
    })
    await expect(refused?.terminalCompletion).resolves.toEqual({
      delivered: false,
      failureNotified: true,
      outcome: { status: 'failed', message: expect.stringContaining('Claude') }
    })
    expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledTimes(dispatched)
    expect(mocks.toastError).toHaveBeenCalledOnce()
  })

  it.each(['deadline', 'prepared', 'authoritative', 'old'] as const)(
    'delivers the actual %s operation once with the correct model owner and final result',
    async (route) => {
      vi.useFakeTimers()
      try {
        mocks.actualOperation = true
        mocks.capability.mockResolvedValue(route !== 'old')
        store.runtimeStatusByEnvironmentId.get('web-runtime')!.status.capabilities =
          route === 'old' ? [] : [AGENT_LAUNCH_CHOICES_CAPABILITY]
        store.settings.agentLaunchChoices = { claude: { options: { effort: 'low' } } }
        store.settings.agentDefaultArgs = { claude: '--verbose' }
        store.settings.agentDefaultEnv = { claude: { KEEP: 'caller' } }
        store.settings.agentCmdOverrides = { claude: 'cx' }
        const hostSettings = {
          agentPermissionDefault: 'own' as const,
          agentLaunchChoices: {
            claude: {
              ...(route === 'prepared' ? {} : { model: 'opus' }),
              options: { effort: 'high' }
            }
          },
          agentDefaultEnv: { claude: { KEEP: 'host' } }
        }
        const pending = Promise.withResolvers<{
          settings: ReturnType<typeof projectAgentLaunchSettings>
        }>()
        mocks.hostRpc.mockImplementation(() =>
          route === 'deadline'
            ? pending.promise
            : Promise.resolve({ settings: projectAgentLaunchSettings(hostSettings) })
        )
        const host = new OrcaRuntimeService(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the final startup owner reads only this settings store.
          { getSettings: () => hostSettings } as never
        )
        Object.assign(host, {
          resolveTerminalWorkspaceLaunchScope: vi.fn(async () => ({
            id: 'wt-1',
            path: '/host',
            connectionId: null,
            repo: null,
            folderWorkspace: null
          }))
        })
        const compiled = vi.spyOn(host, 'planAgentPaneLaunch')
        const prepared = vi.fn(consumeOldHostPreparedCommand)
        const spawn = vi
          .spyOn(host, 'createTerminal')
          .mockImplementation(async (_worktree, options) => {
            await host.planAgentPaneLaunch('wt-1', options ?? {})
            return {
              handle: 'created',
              worktreeId: 'wt-1',
              title: null,
              tabId: 'host-tab',
              paneKey: 'host-tab:leaf'
            }
          })
        const dispatch = vi.fn(async (request) => {
          if (request.method === 'terminal.createAgentSession') {
            return { ok: true, result: await host.createAgentSession(request.params) }
          }
          if (request.method === 'session.tabs.createTerminal') {
            await prepared(request.params)
            return { ok: true, result: { tab: { id: 'host-tab', leafId: 'leaf' } } }
          }
          if (request.method === 'session.tabs.move') {
            return { ok: true, result: {} }
          }
          throw new Error(`Unexpected operation ${request.method}`)
        })
        stubRuntimeEnvironmentBridge({ call: dispatch })
        const { launchAgentInNewTab } =
          await import('../../src/renderer/src/lib/launch-agent-in-new-tab')
        const result = launchAgentInNewTab({
          requestId: newAgentLaunchRequestId(),
          agent: 'claude',
          worktreeId: 'wt-1',
          requestedSurface: 'terminal',
          groupId: 'group-1',
          activate: false,
          agentArgs: '--verbose',
          ...(route === 'prepared' ? { sessionOptions: { effort: 'high' } } : {})
        })
        await vi.advanceTimersByTimeAsync(route === 'deadline' ? 3_000 : 0)
        await expect(result?.terminalCompletion).resolves.toMatchObject({
          outcome: { status: 'created' },
          tabId: 'web-terminal-host-tab'
        })
        const creates = () =>
          dispatch.mock.calls.filter(([request]) =>
            ['terminal.createAgentSession', 'session.tabs.createTerminal'].includes(request.method)
          )
        expect(creates()).toHaveLength(1)
        if (route === 'deadline' || route === 'authoritative') {
          expect(creates()[0][0]).toMatchObject({
            method: 'terminal.createAgentSession',
            params: { agent: 'claude', agentArgs: '--verbose', presentation: 'background' }
          })
          expect(creates()[0][0].params).not.toHaveProperty('launchPreferences')
          expect(spawn).toHaveBeenCalledTimes(1)
          const plan = await compiled.mock.results[0].value
          expect(plan).toMatchObject({
            command: expect.stringContaining("'opus'"),
            env: { KEEP: 'host' },
            launchConfig: { agentArgs: '--verbose' }
          })
          expect(plan?.command).toContain("'high'")
          expect(plan?.command).not.toContain("'low'")
          expect(prepared).not.toHaveBeenCalled()
        } else {
          expect(creates()[0][0]).toMatchObject({
            method: 'session.tabs.createTerminal',
            params: {
              command: `cx '--verbose' '--effort' '${route === 'old' ? 'low' : 'high'}'`,
              env: { KEEP: 'caller' },
              launchConfig: { agentCommand: "cx '--verbose'", agentArgs: '--verbose' },
              targetGroupId: 'group-1',
              activate: false,
              select: false,
              navigation: 'caller'
            }
          })
          expect(prepared).toHaveBeenCalledTimes(1)
          expect(await prepared.mock.results[0].value).toMatchObject({
            command: creates()[0][0].params.command,
            env: { KEEP: 'caller' },
            launchConfig: { agentArgs: '--verbose' }
          })
          expect(spawn).not.toHaveBeenCalled()
        }
        if (route === 'deadline') {
          pending.resolve({ settings: projectAgentLaunchSettings(hostSettings) })
          await vi.advanceTimersByTimeAsync(0)
          expect(creates()).toHaveLength(1)
        }
        expect(mocks.createTab).not.toHaveBeenCalled()
        expect(mocks.toastError).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
        vi.restoreAllMocks()
      }
    }
  )

  it('settles ordinary QuickLaunch preparation independently of prompt observers', async () => {
    mocks.actualOperation = true
    const dispatch = vi.fn(async (request) => ({
      ok: true,
      result:
        request.method === 'session.tabs.createTerminal'
          ? { tab: { id: 'host-tab', leafId: 'leaf' } }
          : {}
    }))
    Object.assign(window, { api: { runtimeEnvironments: { call: dispatch } } })
    let pick = false
    function QuickLaunch() {
      const launch = useTabAgentMenuLaunch({
        worktreeId: 'wt-1',
        groupId: 'group-1',
        onFocusTerminal: vi.fn()
      })
      return createElement(
        'button',
        {
          onClick: () =>
            launch(
              { kind: 'cli', agent: 'claude', executionHostId: 'runtime:web-runtime' },
              pick
                ? { agent: 'claude', surface: 'terminal', choices: { model: 'opus' } }
                : undefined
            )
        },
        'Launch Claude'
      )
    }
    render(createElement(QuickLaunch))
    store.settings.agentDefaultArgs = { claude: "--model 'opus" }
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Launch Claude' })))
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/Claude.*try again/)
    )
    expect(dispatch).not.toHaveBeenCalled()
    mocks.toastError.mockClear()
    store.settings.agentDefaultArgs = {}
    store.settings.agentCmdOverrides = { claude: 'claude --model sonnet' }
    pick = true
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Launch Claude' })))
    expect(mocks.toastError).toHaveBeenCalledOnce()
    expect(dispatch).not.toHaveBeenCalled()
    mocks.toastError.mockClear()
    pick = false
    store.settings.agentLaunchChoices = { claude: { model: 'opus' } }
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Launch Claude' })))
    expect(
      dispatch.mock.calls.filter(([r]) => r.method === 'session.tabs.createTerminal')
    ).toHaveLength(1)
    expect(
      dispatch.mock.calls.find(([r]) => r.method === 'session.tabs.createTerminal')?.[0].params
        .command
    ).toContain('sonnet')
    expect(mocks.toastError).not.toHaveBeenCalled()
    mocks.capability.mockRejectedValueOnce(new Error('private transport detail'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Launch Claude' })))
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/Claude.*try again/)
    )
    expect(mocks.createTab).not.toHaveBeenCalled()
  })

  it.each(['submit-after-ready', 'draft'] as const)(
    'retains the %s prompt with one preparation notice',
    async (promptDelivery) => {
      store.settings.agentDefaultArgs = { claude: "--model 'opus" }
      const handoff = vi.fn()
      function PromptLaunch() {
        const [prompt, setPrompt] = useState('keep this task')
        const launch = useTabAgentMenuLaunch({
          worktreeId: 'wt-1',
          groupId: 'group-1',
          onFocusTerminal: vi.fn(),
          prompt,
          promptDelivery,
          onPromptDelivered: () => setPrompt(''),
          onPromptHandedOff: handoff
        })
        return createElement(
          'div',
          {},
          createElement('textarea', { 'aria-label': 'Task', value: prompt, readOnly: true }),
          createElement(
            'button',
            {
              onClick: () =>
                launch({ kind: 'cli', agent: 'claude', executionHostId: 'runtime:web-runtime' })
            },
            'Launch task'
          )
        )
      }
      render(createElement(PromptLaunch))
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Launch task' })))
      expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(/Claude.*try again/)
      )
      expect(screen.getByRole('textbox', { name: 'Task' })).toHaveProperty(
        'value',
        'keep this task'
      )
      expect(mocks.createWebRuntimeSessionTerminal).not.toHaveBeenCalled()
      expect(mocks.createTab).not.toHaveBeenCalled()
      expect(handoff).toHaveBeenCalledOnce()
      await expect(handoff.mock.calls[0][0]).resolves.toEqual({ delivered: false })
    }
  )

  it.each(['created', 'cancelled', 'late-answer'] as const)(
    'runs the real host wait and single terminal re-entry through %s settlement',
    async (mode) => {
      vi.useFakeTimers()
      mocks.actualOperation = true
      mocks.capability.mockResolvedValue(true)
      vi.mocked(pasteDraftWhenAgentReady).mockResolvedValue(true)
      store.settings.nativeChatProviders = { ...EVERY_AGENT_CHAT }
      store.runtimeStatusByEnvironmentId.get('web-runtime')!.status = {
        hostPlatform: 'linux',
        runtimeId: 'runtime-1',
        capabilities: [
          AGENT_LAUNCH_CHOICES_CAPABILITY,
          STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
        ]
      }
      const listing = Promise.withResolvers<{ agents: [] }>()
      const settings = Promise.withResolvers<{
        settings: ReturnType<typeof projectAgentLaunchSettings>
      }>()
      mocks.hostRpc.mockImplementation((_target, method) =>
        method === AGENT_SESSION_AGENTS_METHOD ? listing.promise : settings.promise
      )
      const dispatch = vi.fn(async (request) => ({
        ok: true,
        result:
          request.method === 'terminal.createAgentSession'
            ? { terminal: { tabId: 'host-tab', paneKey: 'host-tab:leaf' } }
            : {}
      }))
      stubRuntimeEnvironmentBridge({ call: dispatch })
      const { launchAgentInNewTab } =
        await import('../../src/renderer/src/lib/launch-agent-in-new-tab')
      // OpenCode has no built-in structured fallback without the owning host's catalog.
      const result = launchAgentInNewTab({
        requestId: newAgentLaunchRequestId(),
        agent: 'opencode',
        worktreeId: 'wt-1',
        prompt: 'review this context',
        promptDelivery: 'draft'
      })
      expect(mocks.hostRpc).toHaveBeenCalledWith(
        expect.anything(),
        AGENT_SESSION_AGENTS_METHOD,
        {},
        expect.anything()
      )
      expect(dispatch).not.toHaveBeenCalled()
      if (mode === 'late-answer') {
        await vi.advanceTimersByTimeAsync(3_000)
      } else {
        listing.resolve({ agents: [] })
      }
      await vi.advanceTimersByTimeAsync(0)
      expect(
        mocks.hostRpc.mock.calls.filter(([, method]) => method !== AGENT_SESSION_AGENTS_METHOD)
      ).toHaveLength(1)
      if (mode === 'cancelled') {
        replaceRuntimeEnvironmentRevisions([{ id: 'web-runtime', createdAt: 2 }])
      } else {
        settings.resolve({
          settings: projectAgentLaunchSettings({
            agentLaunchChoices: { opencode: { model: 'provider/model' } }
          })
        })
      }
      await vi.advanceTimersByTimeAsync(0)
      await expect(result?.structuredSettlement).resolves.toMatchObject({
        kind: mode === 'cancelled' ? 'cancelled' : 'terminal'
      })
      expect(result?.promptDeliveryResult).toBeDefined()
      await expect(result?.promptDeliveryResult).resolves.toMatchObject({
        delivered: mode !== 'cancelled'
      })
      const creates = () =>
        dispatch.mock.calls.filter(([r]) => r.method === 'terminal.createAgentSession')
      expect(creates()).toHaveLength(mode === 'cancelled' ? 0 : 1)
      listing.resolve({ agents: [] })
      settings.resolve({ settings: projectAgentLaunchSettings({ agentLaunchChoices: {} }) })
      await vi.advanceTimersByTimeAsync(4_000)
      expect(creates()).toHaveLength(mode === 'cancelled' ? 0 : 1)
      expect(mocks.toastError).not.toHaveBeenCalled()
      expect(mocks.createTab).not.toHaveBeenCalled()
    }
  )

  it('retains the prompt and reports once when delivery rejects after an accepted create', async () => {
    mocks.actualOperation = true
    const dispatch = vi.fn(async () => ({
      ok: true,
      result: { tab: { id: 'host-tab', leafId: 'leaf' } }
    }))
    stubRuntimeEnvironmentBridge({ call: dispatch })
    vi.mocked(pasteDraftWhenAgentReady).mockRejectedValueOnce(new Error('paste transport failed'))
    const { launchAgentInNewTab } =
      await import('../../src/renderer/src/lib/launch-agent-in-new-tab')
    const result = launchAgentInNewTab({
      requestId: newAgentLaunchRequestId(),
      agent: 'claude',
      worktreeId: 'wt-1',
      requestedSurface: 'terminal',
      prompt: 'keep this task',
      promptDelivery: 'submit-after-ready'
    })
    await expect(result?.terminalCompletion).resolves.toMatchObject({
      outcome: { status: 'created' },
      delivered: false,
      failureNotified: true
    })
    expect(result?.promptDeliveryResult).toBeDefined()
    await expect(
      newAgentPromptOutcome({ delivery: result!.promptDeliveryResult! })
    ).resolves.toEqual({ delivered: false })
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/opened a terminal for Claude.*Send the prompt/)
    )
    expect(store.seedNativeChatLaunchPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'keep this task' })
    )
    expect(store.markNativeChatLaunchPromptFailed).toHaveBeenCalledOnce()
    expect(dispatch.mock.calls).toHaveLength(1)
  })

  it('forwards prompt launch env and captured config to the host runtime', async () => {
    store.settings.agentDefaultArgs = { codex: '--model gpt-5 --reasoning-effort high' }
    store.settings.agentDefaultEnv = { codex: { CODEX_PROFILE: 'captured' } }
    const { launchAgentInNewTab } =
      await import('../../src/renderer/src/lib/launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-2',
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'fix the spinner',
      groupId: 'group-1'
    })

    expect(result).toEqual(
      expect.objectContaining({
        surface: { kind: 'host-published' },
        pasteDraftAfterLaunch: false
      })
    )
    await result?.terminalCompletion
    expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'web-runtime',
      targetGroupId: 'group-1',
      activate: true,
      agentSessionKind: 'fresh',
      launchAgent: 'codex',
      preparedAgentCommand: false,
      command:
        "codex '-c' 'disable_paste_burst=true' '--model' 'gpt-5' '--reasoning-effort' 'high' 'fix the spinner'",
      env: { CODEX_PROFILE: 'captured' },
      launchConfig: {
        agentCommand: "codex '--model' 'gpt-5' '--reasoning-effort' 'high'",
        agentArgs: '--model gpt-5 --reasoning-effort high',
        agentEnv: { CODEX_PROFILE: 'captured' }
      },
      startupCommandDelivery: 'shell-ready',
      prompt: 'fix the spinner',
      promptDelivery: 'auto-submit',
      viewMode: 'terminal'
    })
    expect(mocks.createTab).not.toHaveBeenCalled()
  })
})

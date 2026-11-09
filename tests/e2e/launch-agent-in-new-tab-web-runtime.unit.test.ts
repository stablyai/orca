// @vitest-environment happy-dom
import { EVERY_AGENT_CHAT } from '../../src/shared/native-chat/every-agent-chat.test-fixture'
import { mocks, store } from './launch-agent-web-terminal.test-fixture'
import { createElement, useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useTabAgentMenuLaunch } from '@/components/tab-bar/QuickLaunchButton'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../src/shared/agent-session/structured-agent-session-surface-capabilities'
import { AGENT_SESSION_AGENTS_METHOD } from '../../src/shared/agent-session/agent-session-registered-agents'
import { pasteDraftWhenAgentReady } from '@/lib/agent-session/messaging/paste/agent-paste-draft'
import { newAgentPromptOutcome } from '@/lib/new-agent-prompt-outcome'
import { newAgentLaunchRequestId } from '@/lib/agent-session/launch/routing/agent-launch-request-id'
import { nonRefusedAgentLaunch } from '@/lib/agent-session/launch/new-tab/agent-tab-launch-outcome.test-fixture'
import { stubRuntimeEnvironmentBridge } from '@/runtime/rpc/testing/runtime-environment-bridge-fixture'
import { AGENT_LAUNCH_CHOICES_CAPABILITY } from '../../src/shared/agent-launch/contracts/agent-launch-runtime-capability'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { consumeOldHostPreparedCommand } from './prepared-action-launch.test-fixture'
import '@/runtime/agent-launch-settings/host-agent-launch-preferences-resource'
import { composeAgentLaunchProfile } from '../../src/shared/agent-launch/choices/tui-agent-launch-defaults'
import { projectAgentLaunchSettings } from '../../src/shared/agent-launch/choices/agent-launch-settings'
import { describe, expect, it, vi } from 'vitest'
import { CreateAgentSessionParams } from '../../src/shared/rpc-contract/agent-session-params'

describe('launchAgentInNewTab paired web runtime', () => {
  it.each(['structured', 'legacy'] as const)(
    'fails visibly before %s creation when section trust capability lookup fails',
    async (route) => {
      mocks.actualOperation = true
      mocks.capability.mockImplementation(async (_environmentId, capability) => {
        if (capability === 'agent-session.trust-worktree.v1') {
          throw new Error('private capability transport failure')
        }
        return route === 'structured'
      })
      const dispatch = vi.fn(async (request: { method: string }) => ({
        ok: true,
        result:
          request.method === 'terminal.createAgentSession'
            ? { terminal: { tabId: 'host-tab', paneKey: 'host-tab:leaf' } }
            : { tab: { id: 'host-tab', leafId: 'leaf' } }
      }))
      stubRuntimeEnvironmentBridge({ call: dispatch })
      const { launchAgentInNewTab } =
        await import('@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab')
      const result = nonRefusedAgentLaunch(
        launchAgentInNewTab({
          requestId: newAgentLaunchRequestId(),
          agent: 'claude',
          worktreeId: 'wt-1',
          requestedSurface: 'terminal',
          activate: false,
          initialCwd: '/outside/section',
          trustWorktreeId: 'repo::/outside/section',
          prompt: 'Resolve conflicts'
        })
      )
      await expect(result?.terminalCompletion).resolves.toMatchObject({
        outcome: { status: 'failed' }
      })
      expect(dispatch).not.toHaveBeenCalled()
      expect(mocks.toastError).toHaveBeenCalledOnce()
    }
  )

  it.each(['deadline', 'edited', 'authoritative', 'old', 'no-trust', 'old-client'] as const)(
    'delivers the actual %s operation once with the correct model owner and final result',
    async (route) => {
      vi.useFakeTimers()
      try {
        mocks.actualOperation = true
        mocks.capability.mockImplementation(
          async (_environmentId, capability) =>
            route !== 'old' &&
            capability !== 'agent-session.create-options.v1' &&
            !(route === 'no-trust' && capability === 'agent-session.trust-worktree.v1')
        )
        store.runtimeStatusByEnvironmentId.get('web-runtime')!.status.capabilities =
          route === 'old' ? [] : [AGENT_LAUNCH_CHOICES_CAPABILITY]
        store.settings.agentLaunchChoices = { claude: { options: { effort: 'low' } } }
        store.settings.agentDefaultArgs = { claude: '--verbose' }
        store.settings.agentDefaultEnv = { claude: { KEEP: 'caller' } }
        store.settings.agentCmdOverrides = { claude: 'cx' }
        const hostSettings = {
          agentCmdOverrides: { claude: '/host/claude' },
          agentPermissionDefault: 'own' as const,
          agentLaunchChoices: {
            claude: {
              model: 'opus',
              options: { effort: 'high' }
            }
          },
          agentDefaultEnv: { claude: { KEEP: 'host' } }
        }
        const pending = Promise.withResolvers<{
          settings: ReturnType<typeof projectAgentLaunchSettings>
        }>()
        mocks.hostRpc.mockImplementation((_target, method) =>
          route === 'deadline'
            ? pending.promise
            : Promise.resolve({
                settings:
                  method === 'settings.get'
                    ? { ...hostSettings, ...composeAgentLaunchProfile(hostSettings) }
                    : projectAgentLaunchSettings(hostSettings)
              })
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
            return {
              ok: true,
              result: await host.createAgentSession(CreateAgentSessionParams.parse(request.params))
            }
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
          await import('../../src/renderer/src/lib/agent-session/launch/new-tab/launch-agent-in-new-tab')
        const result = nonRefusedAgentLaunch(
          launchAgentInNewTab({
            requestId: newAgentLaunchRequestId(),
            agent: 'claude',
            worktreeId: 'wt-1',
            requestedSurface: 'terminal',
            groupId: 'group-1',
            activate: false,
            agentArgs: '--verbose',
            initialCwd: '/host-child',
            ...(route !== 'old-client' ? { trustWorktreeId: 'repo::/host-child' } : {}),
            ...(route === 'edited' ? { sessionOptions: { effort: 'high' } } : {})
          })
        )
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
        if (route !== 'old') {
          expect(creates()[0][0]).toMatchObject({
            method: 'terminal.createAgentSession',
            params: {
              agent: 'claude',
              agentArgs: route === 'edited' ? '--model opus --effort high --verbose' : '--verbose',
              presentation: 'background'
            }
          })
          expect(creates()[0][0].params).not.toHaveProperty('launchPreferences')
          expect(spawn).toHaveBeenCalledTimes(1)
          expect(spawn.mock.calls[0]?.[1]).toMatchObject({ cwd: '/host-child' })
          if (route === 'old-client') {
            expect(mocks.capability).not.toHaveBeenCalledWith(
              'web-runtime',
              'agent-session.trust-worktree.v1'
            )
          }
          if (route === 'no-trust' || route === 'old-client') {
            expect(creates()[0][0].params).not.toHaveProperty('trustWorktreeId')
            expect(spawn.mock.calls[0]?.[1]).not.toHaveProperty('trustWorktreeId')
          } else {
            expect(creates()[0][0].params.trustWorktreeId).toBe('repo::/host-child')
            expect(spawn.mock.calls[0]?.[1]?.trustWorktreeId).toBe('repo::/host-child')
          }
          const plan = await compiled.mock.results[0].value
          expect(plan).toMatchObject({
            command: expect.stringContaining("'opus'"),
            env: { KEEP: 'host' },
            launchConfig: {
              agentArgs: route === 'edited' ? '--model opus --effort high --verbose' : '--verbose'
            }
          })
          expect(plan?.command).toContain('/host/claude')
          expect(plan?.command).toContain("'high'")
          expect(plan?.command).not.toContain("'low'")
          expect(prepared).not.toHaveBeenCalled()
        } else {
          expect(creates()[0][0]).toMatchObject({
            method: 'session.tabs.createTerminal',
            params: {
              command: expect.stringContaining('/host/claude'),
              env: { KEEP: 'host' },
              launchConfig: { agentCommand: "/host/claude '--verbose'", agentArgs: '--verbose' },
              targetGroupId: 'group-1',
              activate: false,
              select: false,
              navigation: 'caller'
            }
          })
          expect(creates()[0][0].params.command).toContain("'opus'")
          expect(creates()[0][0].params.command).not.toContain('desktop')
          expect(prepared).toHaveBeenCalledTimes(1)
          expect(await prepared.mock.results[0].value).toMatchObject({
            command: creates()[0][0].params.command,
            env: { KEEP: 'host' },
            launchConfig: { agentArgs: '--verbose' }
          })
          expect(creates()[0][0].params).not.toHaveProperty('trustWorktreeId')
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
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(
      dispatch.mock.calls.find(([r]) => r.method === 'session.tabs.createTerminal')?.[0].params
    ).not.toHaveProperty('command')
    dispatch.mockClear()
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
    ).toBeUndefined()
    expect(mocks.toastError).not.toHaveBeenCalled()
    mocks.capability.mockRejectedValueOnce(new Error('private transport detail'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Launch Claude' })))
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.createTab).not.toHaveBeenCalled()
  })

  it.each(['submit-after-ready', 'draft'] as const)(
    'retains the %s prompt with one preparation notice',
    async (promptDelivery) => {
      mocks.actualOperation = true
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

  it.each(['created', 'late-answer'] as const)(
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
      mocks.hostRpc.mockImplementation((_target, method) =>
        method === AGENT_SESSION_AGENTS_METHOD
          ? listing.promise
          : Promise.reject(new Error('Host-owned launches need no desktop settings'))
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
        await import('../../src/renderer/src/lib/agent-session/launch/new-tab/launch-agent-in-new-tab')
      // OpenCode has no built-in structured fallback without the owning host's catalog.
      const result = nonRefusedAgentLaunch(
        launchAgentInNewTab({
          requestId: newAgentLaunchRequestId(),
          agent: 'opencode',
          worktreeId: 'wt-1',
          prompt: 'review this context',
          promptDelivery: 'draft'
        })
      )
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
      await expect(result?.structuredSettlement).resolves.toMatchObject({
        kind: 'terminal'
      })
      expect(result?.promptDeliveryResult).toBeDefined()
      await expect(result?.promptDeliveryResult).resolves.toMatchObject({
        delivered: true
      })
      const creates = () =>
        dispatch.mock.calls.filter(([r]) => r.method === 'terminal.createAgentSession')
      expect(creates()).toHaveLength(1)
      listing.resolve({ agents: [] })
      await vi.advanceTimersByTimeAsync(4_000)
      expect(creates()).toHaveLength(1)
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
      await import('../../src/renderer/src/lib/agent-session/launch/new-tab/launch-agent-in-new-tab')
    const result = nonRefusedAgentLaunch(
      launchAgentInNewTab({
        requestId: newAgentLaunchRequestId(),
        agent: 'claude',
        worktreeId: 'wt-1',
        requestedSurface: 'terminal',
        prompt: 'keep this task',
        promptDelivery: 'submit-after-ready'
      })
    )
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
})

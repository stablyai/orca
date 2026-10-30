// @vitest-environment happy-dom
import { mocks, store } from './launch-agent-web-terminal.test-fixture'
import { expect, it, vi } from 'vitest'
import { buildAgentSessionForkPrompt } from '@/lib/agent-session-fork-context'
import type { PreparedAgentSessionFork } from '@/components/terminal-pane/terminal-agent-session-fork'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { newAgentPromptOutcome } from '@/lib/new-agent-prompt-outcome'
import { projectAgentLaunchSettings } from '../../src/shared/agent-launch-settings'

it.each(['local', 'web', 'missing-draft-target', 'native-prefill'] as const)(
  'settles the real fork draft independently of its created destination (%s)',
  async (mode) => {
    const local = mode === 'local'
    const missingTarget = mode === 'missing-draft-target'
    const owned = mode === 'native-prefill'
    const agent = missingTarget || owned ? 'claude' : 'codex'
    const prompt = buildAgentSessionForkPrompt({
      capturedText: Array.from({ length: 50 }, (_, i) => `Assistant: context line ${i}`).join('\n'),
      agentLabel: agent
    })!
    mocks.actualOperation = true
    mocks.hostRpc.mockResolvedValue({
      settings: projectAgentLaunchSettings({ agentLaunchChoices: {} })
    })
    vi.mocked(isWebRuntimeSessionActive).mockReturnValue(!local)
    store.repos = [{ ...store.repos[0], executionHostId: local ? 'local' : 'runtime:web-runtime' }]
    store.settings.activeRuntimeEnvironmentId = local ? null : 'web-runtime'
    mocks.createTab.mockReturnValue({ id: 'fork-tab' })
    const dispatch = vi.fn(async (_request: { params: { command?: string } }) => ({
      ok: true,
      result: { tab: { id: missingTarget ? undefined : 'host-tab', leafId: 'leaf' } }
    }))
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: { call: dispatch },
        ui: { writeTerminalClipboardText: mocks.clipboard }
      }
    })
    const paste = Promise.withResolvers<boolean>()
    vi.mocked(pasteDraftWhenAgentReady).mockReturnValueOnce(paste.promise)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this prepared fork only calls terminal.focus on its pane.
    const pane = { terminal: { focus: vi.fn() } } as unknown as PreparedAgentSessionFork['pane']
    const { startAgentSessionFork } =
      await import('../../src/renderer/src/components/terminal-pane/terminal-agent-session-fork')
    const launcher = await import('../../src/renderer/src/lib/launch-agent-in-new-tab')
    const launched = vi.spyOn(launcher, 'launchAgentInNewTab')
    const forking = startAgentSessionFork({ prompt, agent, worktreeId: 'wt-1', pane })
    if (!missingTarget && !owned) {
      await vi.waitFor(() => expect(pasteDraftWhenAgentReady).toHaveBeenCalledOnce())
      expect(mocks.toastSuccess).not.toHaveBeenCalled()
      expect(mocks.clipboard).not.toHaveBeenCalled()
      paste.resolve(false)
    }
    await expect(forking).resolves.toBe(true)
    const result = launched.mock.results[0]?.value
    expect(result?.promptDeliveryResult).toBeDefined()
    await expect(
      newAgentPromptOutcome({ delivery: result!.promptDeliveryResult! })
    ).resolves.toMatchObject({ delivered: owned })
    if (!local) {
      await expect(result?.terminalCompletion).resolves.toMatchObject({
        outcome: { status: 'created' },
        delivered: owned
      })
    }
    expect(store.createWorktree).toHaveBeenCalledOnce()
    expect(store.getKnownWorktreeById('wt-fork')).toBeDefined()
    expect(store.seedNativeChatLaunchDraft).not.toHaveBeenCalled()
    if (owned) {
      expect(dispatch.mock.calls[0]?.[0].params.command).toContain('--prefill')
      expect(dispatch.mock.calls[0]?.[0].params.command).toContain('context line 49')
      expect(mocks.clipboard).not.toHaveBeenCalled()
      expect(mocks.toastSuccess).toHaveBeenCalledOnce()
    } else {
      expect(mocks.clipboard).toHaveBeenCalledExactlyOnceWith(prompt)
      expect(mocks.toastSuccess).not.toHaveBeenCalled()
      expect(mocks.reveal).toHaveBeenLastCalledWith('wt-fork', { sidebarRevealBehavior: 'auto' })
    }
    expect(mocks.createTab).toHaveBeenCalledTimes(local ? 1 : 0)
    expect(dispatch).toHaveBeenCalledTimes(local ? 0 : 1)
    expect(mocks.toastError).toHaveBeenCalledTimes(local || owned ? 0 : 1)
  }
)

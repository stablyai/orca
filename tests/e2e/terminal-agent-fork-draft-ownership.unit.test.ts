// @vitest-environment happy-dom
import { mocks, store } from './launch-agent-web-terminal.test-fixture'
import { expect, it, vi } from 'vitest'
import { buildAgentSessionForkPrompt } from '@/lib/agent-session-fork-context'
import type { PreparedAgentSessionFork } from '@/components/terminal-pane/terminal-agent-session-fork'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { newAgentPromptOutcome } from '@/lib/new-agent-prompt-outcome'
import { projectAgentLaunchSettings } from '../../src/shared/agent-launch-settings'
import { retainedPrefillHost } from './terminal-agent-fork-retained-prefill.test-fixture'
import { AGENT_SESSION_HOST_AUTHORITY_CAPABILITY } from '../../src/shared/agent-session-host-authority'
import { AGENT_LAUNCH_CHOICES_CAPABILITY } from '../../src/shared/agent-launch-runtime-capability'
import type * as SessionSnapshot from '@/runtime/web-runtime-session-snapshot'

const actualSnapshots = await vi.importActual<typeof SessionSnapshot>(
  '@/runtime/web-runtime-session-snapshot'
)

it.each(['local', 'web'] as const)(
  'settles the real fork draft independently of its created destination (%s)',
  async (mode) => {
    const local = mode === 'local'
    const agent = 'codex'
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
      result: { tab: { id: 'host-tab', leafId: 'leaf' } }
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
    await vi.waitFor(() => expect(pasteDraftWhenAgentReady).toHaveBeenCalledOnce())
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.clipboard).not.toHaveBeenCalled()
    paste.resolve(false)
    await expect(forking).resolves.toBe(true)
    const result = launched.mock.results[0]?.value
    expect(result?.promptDeliveryResult).toBeDefined()
    await expect(
      newAgentPromptOutcome({ delivery: result!.promptDeliveryResult! })
    ).resolves.toMatchObject({ delivered: false })
    if (!local) {
      await expect(result?.terminalCompletion).resolves.toMatchObject({
        outcome: { status: 'created' },
        delivered: false
      })
    }
    expect(store.createWorktree).toHaveBeenCalledOnce()
    expect(store.getKnownWorktreeById('wt-fork')).toBeDefined()
    expect(store.seedNativeChatLaunchDraft).not.toHaveBeenCalled()
    expect(mocks.clipboard).toHaveBeenCalledExactlyOnceWith(prompt)
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.reveal).toHaveBeenLastCalledWith('wt-fork', { sidebarRevealBehavior: 'auto' })
    expect(mocks.createTab).toHaveBeenCalledTimes(local ? 1 : 0)
    expect(dispatch).toHaveBeenCalledTimes(local ? 0 : 1)
    expect(mocks.toastError).toHaveBeenCalledTimes(local ? 0 : 1)
  }
)

it.skipIf(process.platform === 'win32')(
  'keeps the actual POSIX inline fork input after binding failure, lost reply and same-process reclaim',
  async () => {
    const host = await retainedPrefillHost()
    const snapshots = await import('@/runtime/web-runtime-session-snapshot')
    vi.mocked(snapshots.refreshWebRuntimeSessionTabsSnapshot).mockImplementationOnce(
      actualSnapshots.refreshWebRuntimeSessionTabsSnapshot
    )
    const prompt = buildAgentSessionForkPrompt({
      capturedText: Array.from({ length: 50 }, (_, i) => `Assistant: context line ${i}`).join('\n'),
      agentLabel: 'Claude'
    })!
    expect(prompt.split('\n')).toHaveLength(61)
    mocks.actualOperation = true
    store.folderWorkspaces = host.store
      .getFolderWorkspaces()
      .map((row) => ({ ...row, executionHostId: 'runtime:web-runtime' }))
    store.projectGroups = host.store.getProjectGroups()
    mocks.capability.mockImplementation(
      async (_environment, capability) =>
        capability === AGENT_SESSION_HOST_AUTHORITY_CAPABILITY ||
        capability === AGENT_LAUNCH_CHOICES_CAPABILITY
    )
    mocks.hostRpc.mockResolvedValue({
      settings: projectAgentLaunchSettings(host.store.getSettings())
    })
    mocks.createTab.mockReturnValue({ id: 'unexpected-local-tab' })
    store.createWorktree.mockImplementationOnce(async () => {
      const worktree = {
        ...store.worktreesByRepo['repo-1'][0],
        id: host.workspaceId,
        path: host.root
      }
      store.worktreesByRepo = { 'repo-1': [...store.worktreesByRepo['repo-1'], worktree] }
      return { worktree }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: { call: host.transport },
        ui: { writeTerminalClipboardText: mocks.clipboard }
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the prepared fork reads only terminal.focus from its source pane.
    const pane = { terminal: { focus: vi.fn() } } as unknown as PreparedAgentSessionFork['pane']
    const { startAgentSessionFork } =
      await import('@/components/terminal-pane/terminal-agent-session-fork')
    const launcher = await import('@/lib/launch-agent-in-new-tab')
    const launched = vi.spyOn(launcher, 'launchAgentInNewTab')
    const forking = startAgentSessionFork({ prompt, agent: 'claude', worktreeId: 'wt-1', pane })
    void forking.catch(() => {})
    try {
      await host.failBindingAfterHandoff(prompt)
      await expect(forking).resolves.toBe(true)
      expect(host.calls).toHaveLength(2)
      expect(host.calls[1]).toEqual(host.calls[0])
      expect(host.calls[0]).toMatchObject({ prompt, promptDelivery: 'draft' })
      expect(host.create).toHaveBeenCalledOnce()
      expect(host.compile).toHaveBeenCalledOnce()
      expect(host.compile).toHaveBeenCalledWith(
        expect.objectContaining({ prompt, promptDelivery: 'draft' })
      )
      expect(host.spawn).toHaveBeenCalledOnce()
      expect(host.physicalSpawn).toHaveBeenCalledOnce()
      const [inventory] = await host.provider.listProcesses()
      expect(inventory).toMatchObject({
        worktreeId: host.workspaceId,
        rootProcessId: host.process.pid
      })
      expect(inventory?.terminalHandle).toEqual(expect.any(String))
      expect(host.create.mock.calls[0]?.[1]?.preAllocatedHandle).toBe(inventory?.terminalHandle)
      expect(host.provider.getPtyProcess(inventory!.id)).toBe(host.process)
      expect(host.replies).toEqual([
        {
          disposition: 'replayed',
          terminal: {
            handle: inventory!.terminalHandle,
            ptyId: inventory!.id,
            worktreeId: host.workspaceId,
            title: 'zsh',
            surface: 'background'
          }
        }
      ])
      expect(host.replies[0]?.terminal).not.toHaveProperty('tabId')
      expect(host.replies[0]?.terminal).not.toHaveProperty('paneKey')
      expect(host.events).toEqual([
        'transport-1',
        'physical-spawn',
        'binding-pending',
        'startup-write',
        'binding-failed',
        'termination-failed',
        'host-failure-reply-lost',
        'transport-2',
        'reclaimed',
        'post-create-list-failed'
      ])
      const result = launched.mock.results[0]?.value
      await expect(result?.terminalCompletion).resolves.toMatchObject({
        outcome: { status: 'created' },
        delivered: true
      })
      await expect(result?.promptDeliveryResult).resolves.toEqual({
        outcome: { status: 'created' },
        delivered: true,
        failureNotified: false
      })
      expect(host.writes).toHaveLength(1)
      expect(store.createWorktree).toHaveBeenCalledOnce()
      expect(store.getKnownWorktreeById(host.workspaceId)).toBeDefined()
      expect(
        host.store
          .getFolderWorkspaces()
          .filter((row) => row.id === host.workspaceId.slice('folder:'.length))
      ).toHaveLength(1)
      expect(store.seedNativeChatLaunchDraft).not.toHaveBeenCalled()
      expect(pasteDraftWhenAgentReady).not.toHaveBeenCalled()
      expect(mocks.createTab).not.toHaveBeenCalled()
      expect(mocks.clipboard).not.toHaveBeenCalled()
      expect(mocks.toastError).not.toHaveBeenCalled()
      expect(mocks.toastSuccess).toHaveBeenCalledExactlyOnceWith(
        'Top-level session fork opened in a new workspace'
      )
    } finally {
      host.releaseBinding()
      host.exit()
      await forking
    }
  }
)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installIpcPtyWindow, restorePtySpecWindow } from './pty-transport-test-harness'
import { describeLaunchFileUnavailable } from '../../../../shared/launch-prompt-file'
import type { PtyPaneStartup } from './pty-connection-types'

const mocks = vi.hoisted(() => {
  const ptyIdsByTabId: Record<string, string[]> = {}
  return { showNotStarted: vi.fn(), closeTerminalTab: vi.fn(), ptyIdsByTabId }
})
vi.mock('@/lib/agent-launch-prompt-not-delivered-notice', () => ({
  showAgentLaunchNotStartedNotice: mocks.showNotStarted
}))
vi.mock('@/components/terminal/terminal-tab-actions', () => ({
  closeTerminalTab: mocks.closeTerminalTab
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ ptyIdsByTabId: mocks.ptyIdsByTabId }) }
}))

describe('a pane spawn the host refused for what carries its prompt', () => {
  const originalWindow = globalThis.window

  beforeEach(() => {
    vi.resetModules()
    mocks.showNotStarted.mockReset()
    mocks.closeTerminalTab.mockReset()
    installIpcPtyWindow(originalWindow, { data: () => {}, exit: () => {} })
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
  })

  // Why: a WSL launch with no launch file still needs its staged line written into the distro.
  it('hands back a staged line’s prompt to copy, as it does a launch file’s', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    vi.mocked(window.api.pty.spawn).mockRejectedValueOnce(
      new Error(describeLaunchFileUnavailable('unreachable', 'staged-line'))
    )

    await createIpcPtyTransport({
      command: "claude 'a long prompt'",
      launchPrompt: 'a long prompt'
    }).connect({ url: '', callbacks: { onError: vi.fn() } })

    expect(mocks.showNotStarted).toHaveBeenCalledWith({ prompt: 'a long prompt' })
  })

  // Why (stack QA, new agent tab with the temp folder read-only): the empty pane's recovery spawned
  // it again, so the notice showed twice, under a red error panel, in a tab left open with nothing.
  it('tells the user once, with no error panel, and closes the tab it left empty', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const refusal = new Error(describeLaunchFileUnavailable('EACCES', 'staged-line'))
    vi.mocked(window.api.pty.spawn).mockRejectedValue(refusal)
    const onError = vi.fn()
    const connect = () =>
      createIpcPtyTransport({
        command: "claude 'a long prompt'",
        launchPrompt: 'a long prompt',
        tabId: 'tab-refused',
        worktreeId: 'wt-1'
      }).connect({ url: '', callbacks: { onError } })

    await connect()
    await connect()

    expect(mocks.showNotStarted).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect(mocks.closeTerminalTab).toHaveBeenCalledWith('tab-refused', {
        force: true,
        skipRunningProcessConfirm: true,
        captureRecentlyClosed: false
      })
    )
  })

  it('leaves a tab that still holds a live terminal', async () => {
    mocks.ptyIdsByTabId['tab-with-shell'] = ['pty-live']
    const { createIpcPtyTransport } = await import('./pty-transport')
    vi.mocked(window.api.pty.spawn).mockRejectedValueOnce(
      new Error(describeLaunchFileUnavailable('EACCES', 'staged-line'))
    )

    await createIpcPtyTransport({
      command: "claude 'a long prompt'",
      launchPrompt: 'a long prompt',
      tabId: 'tab-with-shell',
      worktreeId: 'wt-1'
    }).connect({ url: '', callbacks: { onError: vi.fn() } })

    expect(mocks.showNotStarted).toHaveBeenCalledTimes(1)
    // The close reads the store after a lazy import; let it settle before asserting it did not run.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mocks.closeTerminalTab).not.toHaveBeenCalled()
  })

  it('sends the caller’s wish for a line the host cannot stage with the spawn', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    vi.mocked(window.api.pty.spawn).mockRejectedValueOnce(new Error('spawn ENOENT'))

    await createIpcPtyTransport({
      command: "claude 'a long prompt'",
      launchPrompt: 'a long prompt',
      unstageableLine: 'refuse'
    }).connect({ url: '', callbacks: { onError: vi.fn() } })

    expect(window.api.pty.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ unstageableLine: 'refuse' })
    )
  })

  it('carries that wish from the pane’s queued startup to the transport', async () => {
    const { paneStartupCommandOptions } =
      await import('./pty-connection/pane-startup-command-options')
    const paneStartup: PtyPaneStartup = { command: 'claude x', unstageableLine: 'refuse' }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the helper reads only these two members.
    const session = {
      shouldDeliverStartupViaTerminalPaste: false,
      paneStartup
    } as unknown as Parameters<typeof paneStartupCommandOptions>[0]

    expect(paneStartupCommandOptions(session)).toMatchObject({ unstageableLine: 'refuse' })
  })

  it('stays quiet for any other spawn failure', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    vi.mocked(window.api.pty.spawn).mockRejectedValueOnce(new Error('spawn ENOENT'))

    await createIpcPtyTransport({ command: 'claude', launchPrompt: 'fix it' }).connect({
      url: '',
      callbacks: { onError: vi.fn() }
    })

    expect(mocks.showNotStarted).not.toHaveBeenCalled()
  })
})

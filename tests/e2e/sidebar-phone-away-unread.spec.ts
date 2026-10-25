/**
 * A phone holding a workspace open mutes the host's unread flag only while it is in the
 * foreground: once it reports away, a finish there is news; once it is back, the flag is read.
 */
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { postClaudeHook, readHookEndpoint } from './helpers/agent-hook-endpoint'
import { SIDEBAR_INPUTS_BUILD } from './helpers/sidebar-inputs-build'
import { createDesktopMobilePairingOffer } from './helpers/paired-electron-client'
import { pairMobileClient } from './helpers/paired-mobile-client'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import { WorkspaceRowsSnapshotSchema } from '../../src/shared/sidebar-list/workspace-rows'

test.skip(
  !SIDEBAR_INPUTS_BUILD,
  'the host raises the unread flag only in an ORCA_SIDEBAR_INPUTS=main build'
)

async function hostRow(page: Page, rowKey: string) {
  const response = await page.evaluate(() =>
    window.api.runtime.call({ method: 'sidebarInputs.workspaceRows' })
  )
  if (!response.ok) {
    throw new Error('sidebarInputs.workspaceRows failed')
  }
  return WorkspaceRowsSnapshotSchema.parse(response.result).rows[rowKey]
}

test('a backgrounded phone stops muting the unread flag, and reads it on return', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(120_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const endpoint = await readHookEndpoint(electronApp)
  const pane = await waitForActivePaneHookDescriptor(orcaPage)
  const rowKey = `local|${pane.worktreeId}`
  const unread = async () => (await hostRow(orcaPage, rowKey))?.isUnread
  const tier = async () => (await hostRow(orcaPage, rowKey))?.smartTier
  // Waits on the host's tier so a quiet flag after it is a real verdict, not a race.
  const finishTurn = async (): Promise<void> => {
    await postClaudeHook(endpoint, pane, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await expect.poll(tier).not.toBe('done')
    await postClaudeHook(endpoint, pane, { hook_event_name: 'Stop', last_assistant_message: 'ok' })
    await expect.poll(tier).toBe('done')
  }
  // No workspace on the window's screen, so only the phone can be looking.
  await orcaPage.evaluate(() => window.__store?.setState({ activeView: 'tasks' }))

  const phone = pairMobileClient(await createDesktopMobilePairingOffer(orcaPage))
  const socket = await phone.openSocket()
  try {
    socket.send('tabs', 'session.tabs.subscribe', { worktree: `id:${pane.worktreeId}` })
    await expect.poll(() => socket.frames.some((frame) => frame.id === 'tabs')).toBe(true)
    await finishTurn()
    expect(await unread()).toBe(false)

    const report = async (id: string, presentForMs: number | null): Promise<void> => {
      socket.send(id, 'sidebarInputs.reportView', { workspaceIds: [], tabIds: [], presentForMs })
      await expect.poll(() => socket.frames.find((frame) => frame.id === id)?.ok).toBe(true)
    }
    // The phone left the foreground (locked or backgrounded), its socket still open.
    await report('away', 0)
    await finishTurn()
    await expect.poll(unread).toBe(true)

    // Back in the foreground with the workspace still open: read, and muted again.
    await report('back', null)
    await expect.poll(unread).toBe(false)
    await finishTurn()
    expect(await unread()).toBe(false)
  } finally {
    phone.dispose()
  }
})

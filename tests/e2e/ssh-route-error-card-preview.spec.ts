// Interactive SSH-routing card preview; run electron-headless with ORCA_SSH_CARD_PREVIEW=1 on an isolated display.
import { expect, test } from './helpers/orca-app'

test.skip(
  process.env.ORCA_SSH_CARD_PREVIEW !== '1',
  'Preview only; run with ORCA_SSH_CARD_PREVIEW=1'
)

const HOLD_MINUTES = 20

test('shows the SSH routing error cards and holds for review', async ({
  electronApp,
  orcaPage,
  testRepoPath
}) => {
  test.setTimeout((HOLD_MINUTES + 10) * 60_000)

  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window?.setSize(1440, 900)
    window?.center()
    window?.show()
    window?.focus()
  })

  await expect
    .poll(
      () =>
        orcaPage.evaluate(
          (path) =>
            window.__store
              ?.getState()
              .allWorktrees()
              .find((worktree) => worktree.path === path)?.id ?? null,
          testRepoPath
        ),
      { timeout: 60_000, message: 'test repo worktree never appeared' }
    )
    .not.toBeNull()
  await orcaPage.evaluate((path) => {
    const state = window.__store?.getState()
    const worktree = state?.allWorktrees().find((candidate) => candidate.path === path)
    if (!worktree) {
      throw new Error('worktree missing')
    }
    state?.setActiveWorktree(worktree.id)
  }, testRepoPath)

  // Use a real unreachable registered target so production prepare classifies ssh-unavailable.
  const targetId = await orcaPage.evaluate(async () => {
    const added = (await window.api.ssh.addTarget({
      target: {
        label: 'preview-dead-host',
        host: '127.0.0.1',
        port: 1,
        username: 'preview'
      }
    })) as { target?: { id?: string } }
    const id = added?.target?.id
    if (!id) {
      throw new Error(`addTarget returned ${JSON.stringify(added)}`)
    }
    return id
  })
  await orcaPage.evaluate((id) => {
    // Replace the activation-stamped local host id because it has resolution precedence.
    window.__store?.setState({
      activeWorkspaceExecutionHostId: `ssh:${encodeURIComponent(id)}`
    })
  }, targetId)

  await orcaPage.evaluate(async () => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const groupId = worktreeId ? state?.activeGroupIdByWorktree[worktreeId] : null
    if (!state || !groupId) {
      throw new Error('No active browser group')
    }
    await state.openNewBrowserTabInActiveWorkspace(groupId)
  })

  await expect(orcaPage.getByText('SSH connection unavailable')).toBeVisible({
    timeout: 30_000
  })
  console.log(`\n=== SSH ERROR CARD PREVIEW READY — window stays up ${HOLD_MINUTES} minutes ===`)
  console.log('Showing the real classified ssh-unavailable card (dead registered host, no stubs).')
  console.log('"Retry" re-runs prepare; "Browse from this device instead" is the real escape')
  console.log(
    'hatch: a local browser mounts, and Settings -> Browser lists the host with Route again.\n'
  )
  await new Promise((resolve) => setTimeout(resolve, HOLD_MINUTES * 60_000))
})

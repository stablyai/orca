// Throwaway interactive preview (untracked): shows the SSH-routing error cards
// in a headed app and holds it open for review. The prepare IPC is stubbed at
// the window level; everything else (gate, settings writes, escape hatch) is real.
// Run: ORCA_SSH_CARD_PREVIEW=1 pnpm exec playwright test --config tests/playwright.config.ts \
//   --project electron-headless --workers=1 tests/e2e/ssh-route-error-card-preview.spec.ts
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

  // Stage with a REAL registered SSH target (a dead address) — no stubbing:
  // prepare runs the true main-process path and fails as 'ssh-unavailable',
  // rendering the classified card exactly as a user would see it.
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
    // Why: the active-workspace host id wins resolution precedence and was
    // stamped 'local' at activation; the gate consults it first.
    window.__store?.setState({
      activeWorkspaceExecutionHostId: `ssh:${encodeURIComponent(id)}`
    })
  }, targetId)

  await orcaPage.evaluate(async () => {
    await window.__store?.getState().openNewBrowserTabInActiveWorkspace()
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

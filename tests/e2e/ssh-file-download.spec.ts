import os from 'os'
import path from 'path'
import { existsSync, readFileSync, rmSync } from 'fs'

import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const RUN_LOCALHOST_SSH = process.env.ORCA_E2E_SSH_LOCALHOST === '1'

function currentUsername(): string {
  return (
    process.env.ORCA_E2E_SSH_USER ??
    process.env.USER ??
    process.env.USERNAME ??
    os.userInfo().username
  )
}

test.describe('SSH file download', () => {
  test.skip(
    !RUN_LOCALHOST_SSH,
    'Set ORCA_E2E_SSH_LOCALHOST=1 (with key auth to localhost) to run this SSH download E2E.'
  )
  test.skip(process.platform === 'win32', 'Localhost SSH download E2E uses a POSIX remote.')

  test('shows Download on remote files and writes the file locally', async ({
    orcaPage,
    electronApp,
    testRepoPath
  }) => {
    test.slow()
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)

    const identityFile = process.env.ORCA_E2E_SSH_IDENTITY_FILE?.trim()
    const target = {
      label: `Download SSH E2E ${Date.now()}`,
      host: process.env.ORCA_E2E_SSH_HOST?.trim() || '127.0.0.1',
      port: Number(process.env.ORCA_E2E_SSH_PORT ?? '22'),
      username: currentUsername(),
      ...(identityFile ? { identityFile } : {})
    }

    // ── Connect SSH + mount the remote repo, then open the explorer ──
    const remote = await orcaPage.evaluate(
      async ({ remotePath, target }) => {
        const store = window.__store
        if (!store) {
          throw new Error('Store unavailable')
        }
        const credentialUnsub = window.api.ssh.onCredentialRequest((request) => {
          void window.api.ssh.submitCredential({ requestId: request.requestId, value: null })
        })
        try {
          const createdTarget = await window.api.ssh.addTarget({
            target: { ...target, relayGracePeriodSeconds: 1 }
          })
          const state = await window.api.ssh.connect({ targetId: createdTarget.id })
          if (!state || state.status !== 'connected') {
            throw new Error(`SSH target did not connect: ${JSON.stringify(state)}`)
          }
          store.getState().setSshConnectionState(createdTarget.id, state)
          const labels = new Map(store.getState().sshTargetLabels)
          labels.set(createdTarget.id, createdTarget.label)
          store.getState().setSshTargetLabels(labels)

          const result = await window.api.repos.addRemote({
            connectionId: createdTarget.id,
            remotePath,
            displayName: 'Download SSH E2E'
          })
          if ('error' in result) {
            throw new Error(result.error)
          }
          await store.getState().fetchRepos()
          await store.getState().fetchWorktrees(result.repo.id)
          const worktrees = store.getState().worktreesByRepo[result.repo.id] ?? []
          const worktree =
            worktrees.find((candidate) => candidate.path === result.repo.path) ?? worktrees[0]
          if (!worktree) {
            throw new Error('No remote worktree found')
          }
          store.getState().setActiveWorktree(worktree.id)
          store.getState().setRightSidebarOpen(true)
          store.getState().setRightSidebarTab('explorer')
          return { targetId: createdTarget.id, worktreeId: worktree.id }
        } finally {
          credentialUnsub()
        }
      },
      { remotePath: testRepoPath, target }
    )
    expect(remote.targetId).toBeTruthy()

    // Why: fetchRepos/fetchWorktrees settle asynchronously and can re-derive the
    // active worktree after our initial set; re-assert it (and the explorer
    // panel) until it sticks so the remote tree actually mounts.
    await expect
      .poll(
        async () =>
          orcaPage.evaluate((worktreeId) => {
            const state = window.__store?.getState()
            if (!state) {
              return false
            }
            if (state.activeWorktreeId !== worktreeId) {
              state.setActiveWorktree(worktreeId)
            }
            state.setRightSidebarOpen(true)
            state.setRightSidebarTab('explorer')
            const worktree = Object.values(state.worktreesByRepo)
              .flat()
              .find((candidate) => candidate.id === worktreeId)
            return Boolean(worktree) && state.activeWorktreeId === worktreeId
          }, remote.worktreeId),
        { timeout: 20_000, message: 'Active remote worktree did not stabilize' }
      )
      .toBe(true)

    const explorer = orcaPage.locator('[data-orca-explorer-shell]')
    const readmeRow = explorer.getByRole('button', { name: 'README.md', exact: false })
    await expect(readmeRow).toBeVisible({ timeout: 30_000 })

    // ── 1. Right-click a remote file → "Download..." is offered ──
    await readmeRow.click({ button: 'right' })
    const downloadItem = orcaPage.getByRole('menuitem', { name: 'Download...' })
    await expect(downloadItem).toBeVisible({ timeout: 10_000 })

    // ── 2. Probe: directories must NOT offer Download ──
    await orcaPage.keyboard.press('Escape')
    await expect(downloadItem).toHaveCount(0)
    const srcRow = explorer.getByRole('button', { name: 'src', exact: false }).first()
    await srcRow.click({ button: 'right' })
    // "Find in Folder" is directory-only — its presence proves the folder menu
    // opened, so a Download absence below is meaningful (not a closed menu).
    await expect(orcaPage.getByRole('menuitem', { name: 'Find in Folder' }).first()).toBeVisible({
      timeout: 10_000
    })
    await expect(orcaPage.getByRole('menuitem', { name: 'Download...' })).toHaveCount(0)
    await orcaPage.keyboard.press('Escape')
    await expect(orcaPage.getByRole('menuitem', { name: 'Find in Folder' })).toHaveCount(0)

    // ── Stub the native save dialog in the main process → temp dest ──
    const destPath = path.join(os.tmpdir(), `orca-download-e2e-${Date.now()}.md`)
    rmSync(destPath, { force: true })
    await electronApp.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    }, destPath)

    // ── 3. Click Download → the remote file lands on local disk ──
    await readmeRow.click({ button: 'right' })
    await orcaPage.getByRole('menuitem', { name: 'Download...' }).click()

    await expect
      .poll(() => existsSync(destPath), {
        timeout: 20_000,
        message: 'Downloaded file did not appear on local disk'
      })
      .toBe(true)

    const downloaded = readFileSync(destPath, 'utf-8')
    const expected = readFileSync(path.join(testRepoPath, 'README.md'), 'utf-8')
    expect(downloaded).toBe(expected)

    rmSync(destPath, { force: true })
  })
})

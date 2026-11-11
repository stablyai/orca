import { randomBytes } from 'node:crypto'
import { copyFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'
import { openTerminalWorkspaceRootLink } from './helpers/terminal-workspace-root-link'

// #35968: a host file outside every workspace is read through its grant, which once allowed only a whole-file text read.
test('a paired terminal link to a video outside every workspace plays it', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.skip(process.platform === 'win32', 'The host grants terminal paths under /tmp')
  // Launches and pairs a second Electron client, then streams video through it; loaded CI needs the headroom.
  test.setTimeout(240_000)
  const videoPath = `/tmp/orca-granted-${randomBytes(4).toString('hex')}.mp4`
  copyFileSync(path.join(process.cwd(), 'docs/site/public/docs/videos/tab-split.mp4'), videoPath)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const client = await launchPairedElectronClient(
    await createRuntimeDesktopPairingOffer(orcaPage),
    testInfo,
    'Granted video'
  )
  try {
    const page = client.page
    await expect
      .poll(
        () =>
          page.evaluate(
            (repoPath) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((worktree) => worktree.path === repoPath),
            testRepoPath
          ),
        { timeout: 60_000 }
      )
      .toBe(true)
    await page.evaluate(
      ({ repoPath, environmentId }) => {
        const state = window.__store!.getState()
        const worktree = state.allWorktrees().find((entry) => entry.path === repoPath)!
        state.setActiveWorktree(worktree.id, `runtime:${environmentId}`)
      },
      { repoPath: testRepoPath, environmentId: client.environmentId }
    )
    await ensureTerminalVisible(page, 30_000)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForActivePanePtyId(page, 30_000)

    await openTerminalWorkspaceRootLink(page, testInfo, videoPath, 'open')

    const video = page.locator('video')
    await expect(video).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.duration))
      .toBeGreaterThan(4)
    await expect(page.getByText('Unable to load file', { exact: true })).toHaveCount(0)
  } finally {
    await client.dispose()
    rmSync(videoPath, { force: true })
  }
})

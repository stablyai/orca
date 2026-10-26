import { copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import { waitForSessionReady } from './helpers/store'

test.use({ seedTestRepo: false })

test('restores media playback after switching editor tabs without retaining the player', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const folder = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-media-position-')))
  registerPostElectronShutdownCleanup(async () => rmSync(folder, { recursive: true, force: true }))
  copyFileSync(
    path.resolve('docs/site/public/docs/videos/tab-split.mp4'),
    path.join(folder, 'playback.mp4')
  )
  writeFileSync(path.join(folder, 'other.txt'), 'Switch back to the media tab.\n')

  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(async (folder) => {
    await window.__store?.getState().addRepoPath(folder, 'folder')
  }, folder)
  await orcaPage
    .getByRole('option')
    .filter({ hasText: path.basename(folder) })
    .click()
  await openFileExplorer(orcaPage)
  const row = (name: string) =>
    orcaPage.locator('[data-file-explorer-row]').filter({
      has: orcaPage.locator('[data-file-explorer-row-name]').getByText(name, { exact: true })
    })
  await row('playback.mp4').dblclick()
  const video = orcaPage.locator('video')
  await expect
    .poll(() => video.evaluate((media: HTMLVideoElement) => media.readyState))
    .toBeGreaterThanOrEqual(2)
  await video.evaluate(async (media: HTMLVideoElement) => {
    media.muted = true
    media.currentTime = 1
    await media.play()
  })
  await expect
    .poll(() => video.evaluate((media: HTMLVideoElement) => media.currentTime))
    .toBeGreaterThan(1.1)
  const savedTime = await video.evaluate((media: HTMLVideoElement) => {
    media.pause()
    return media.currentTime
  })
  const previousPlayer = await video.elementHandle()
  if (!previousPlayer) {
    throw new Error('Media player disappeared before switching tabs')
  }

  await row('other.txt').dblclick()
  await expect(video).toHaveCount(0)
  expect(
    await previousPlayer.evaluate((media: HTMLVideoElement) => ({
      connected: media.isConnected,
      paused: media.paused,
      source: media.getAttribute('src')
    }))
  ).toEqual({ connected: false, paused: true, source: null })

  await orcaPage.locator('[data-tab-id]').filter({ hasText: 'playback.mp4' }).click()
  await expect
    .poll(() => video.evaluate((media: HTMLVideoElement) => media.readyState))
    .toBeGreaterThanOrEqual(2)
  expect(await video.evaluate((media: HTMLVideoElement) => media.currentTime)).toBeCloseTo(
    savedTime,
    1
  )
  expect(
    await video.evaluate((media: HTMLVideoElement) => ({
      paused: media.paused,
      controls: media.controls
    }))
  ).toEqual({
    paused: true,
    controls: true
  })
  await video.evaluate((media: HTMLVideoElement) => media.play())
  await expect
    .poll(() => video.evaluate((media: HTMLVideoElement) => media.currentTime))
    .toBeGreaterThan(savedTime + 0.1)
  await video.evaluate((media: HTMLVideoElement) => media.pause())
})

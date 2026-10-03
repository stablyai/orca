/**
 * E2E test for in-app media preview (issue #8344).
 *
 * User Prompt:
 * - opening a .webm from the file explorer renders a playable in-app video
 *   player instead of "Binary file — cannot display"
 */

import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { clickFileInExplorer, openFileExplorer } from './helpers/file-explorer'
import { waitForActiveWorktree, waitForSessionReady, getActiveTabType } from './helpers/store'

// Why: a real 1s VP8+Opus clip (generated with ffmpeg) — the player asserts on
// decoded metadata, so the fixture must be a decodable container, not junk bytes.
const TINY_WEBM_BASE64 =
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAABOZEU2bdLpNu4tTq4QVSalmU6yBoU27i1Or' +
  'hBZUrmtTrIHYTbuMU6uEElTDZ1OsggGLTbuMU6uEHFO7a1OsghOD7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirX' +
  'sYMPQkBNgI1MYXZmNjIuMTIuMTAyV0GNTGF2ZjYyLjEyLjEwMkSJiECPgAAAAAAAFlSua0CtrgEAAAAAAAA/14EBc8WIk6ML' +
  'Y6vz1TucgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QF9eEA4JCwgYC6gUiagQJVsIRVuYEBrgEAAAAAAABc14ECc8WIJgR+' +
  'lIfyplScgQAitZyDdW5kiIEAhoZBX09QVVNWqoNjLqBWu4QExLQAg4EC4ZGfgQG1iEDncAAAAAAAYmSBEGOik09wdXNIZWFk' +
  'AQE4AYC7AAAAAAASVMNnQNZzc6BjwIBnyJpFo4dFTkNPREVSRIeNTGF2ZjYyLjEyLjEwMnNz1mPAi2PFiJOjC2Or89U7Z8ih' +
  'RaOHRU5DT0RFUkSHlExhdmM2Mi4yOC4xMDIgbGlidnB4Z8ihRaOIRFVSQVRJT05Eh5MwMDowMDowMS4wMDAwMDAwMDAAc3PX' +
  'Y8CLY8WIJgR+lIfyplRnyKJFo4dFTkNPREVSRIeVTGF2YzYyLjI4LjEwMiBsaWJvcHVzZ8ihRaOIRFVSQVRJT05Eh5MwMDow' +
  'MDowMS4wMDgwMDAwMDAAH0O2dVEW54EAo+OCAACAeIGnXWyemawAAAgK4Fc5eAj+oI/KPI7NLS+BNjWbAb32eUeWk0FM13r1' +
  '/3aC8RChw0WgDZIlr/LHwem56mZ43FdT6X566lHTS6DV6p8HnADD9vrQYnFlmls0gNiGLEWjzoEAAIDQBACdASqAAEgAAEcI' +
  'hYWIhYSIAgICdaoD+AIGpxka6m9xF5YBrqb3EXlgGupvbQD+71Ev/31U++qn31U/76qf/Xo/no/no/zgAKPDggAVgHifZwHn' +
  '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' +
  'zf5gHFO7a5G7j7OBALeK94EB8YICZ/CBaA=='
const MEDIA_FILE_NAME = 'media-preview-clip.webm'

test('opening a webm from the file explorer renders the in-app media player', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await openFileExplorer(orcaPage)

  const worktreePath = await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    if (!state || !worktreeId) {
      throw new Error('active worktree unavailable')
    }
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((candidate) => candidate.id === worktreeId)
    if (!worktree) {
      throw new Error('active worktree path unavailable')
    }
    return worktree.path
  })

  const mediaFilePath = path.join(worktreePath, MEDIA_FILE_NAME)
  writeFileSync(mediaFilePath, Buffer.from(TINY_WEBM_BASE64, 'base64'))
  try {
    const clickedFile = await clickFileInExplorer(orcaPage, [MEDIA_FILE_NAME])
    expect(clickedFile).toBe(MEDIA_FILE_NAME)

    await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 5_000 }).toBe('editor')

    // Why: the load-bearing check is that MediaViewer actually mounted with a
    // playable source. The editor chunk is lazy-loaded, so the first mount in a
    // fresh headless session can take 10s+ before the player appears.
    const player = orcaPage.locator('[data-orca-media-viewer="player"]')
    await expect(player).toBeVisible({ timeout: 20_000 })

    const video = player.locator('video')
    await expect(video).toBeVisible({ timeout: 5_000 })

    // Why: readyState >= 1 (HAVE_METADATA) proves Chromium decoded the blob URL
    // end to end; a wired-but-broken source would fire onError and swap the
    // player for the error state instead.
    await expect
      .poll(
        async () => video.evaluate((element) => (element as HTMLVideoElement).readyState),
        { timeout: 10_000 }
      )
      .toBeGreaterThanOrEqual(1)
    await expect(orcaPage.locator('[data-orca-media-viewer="error"]')).toHaveCount(0)
    await expect(orcaPage.getByText('Binary file — cannot display')).toHaveCount(0)
  } finally {
    rmSync(mediaFilePath, { force: true })
  }
})

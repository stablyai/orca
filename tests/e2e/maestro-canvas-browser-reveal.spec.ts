import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  activeWorkspaceTabContentType,
  createCanvasResource,
  openMaestro,
  removeWorkspaceResources
} from './fixtures/maestro-workspace-tab-canvas/evidence'
import {
  fitCanvas,
  revealSurfaceAtReadableScale,
  startBrowserProofPage
} from './fixtures/maestro-canvas-agent-topology-performance/browser-reveal'
import {
  PROFILES,
  capture,
  prepareEvidence,
  writeManifest
} from './fixtures/maestro-canvas-agent-topology-performance/evidence'

test('@mtp-browser-reveal keeps the exact Browser readable from deep zoom', async ({
  orcaPage
}) => {
  test.setTimeout(180_000)
  prepareEvidence()
  await orcaPage.setViewportSize(PROFILES.notebook)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await openMaestro(orcaPage, true)
  await removeWorkspaceResources(orcaPage)

  const browserProof = await startBrowserProofPage()
  const evidenceFiles: string[] = []
  try {
    await createCanvasResource(orcaPage, 'browser')
    const browserSurface = orcaPage.locator('[data-maestro-workspace-content-type="browser"]')
    await expect(browserSurface).toHaveCount(1, { timeout: 30_000 })
    const browserPageId = await browserSurface.getAttribute('data-maestro-browser-page-id')
    expect(browserPageId).toBeTruthy()
    await browserSurface.getByRole('button', { name: 'Focus exact tab' }).click()
    await expect.poll(() => activeWorkspaceTabContentType(orcaPage)).toBe('browser')
    const addressBar = orcaPage.locator('[data-orca-browser-address-bar="true"]')
    await addressBar.fill(browserProof.url)
    await addressBar.press('Enter')
    await expect
      .poll(
        () =>
          orcaPage.evaluate(async () => {
            const webview = document.querySelector('webview') as Electron.WebviewTag | null
            return webview
              ? await webview.executeJavaScript('document.querySelector("h1")?.textContent')
              : null
          }),
        { timeout: 30_000 }
      )
      .toBe('Maestro exact Browser')
    await openMaestro(orcaPage, true)
    await expect(
      browserSurface.locator(`img[data-browser-page-id="${browserPageId}"]`)
    ).toBeVisible({ timeout: 30_000 })

    await fitCanvas(orcaPage)
    for (let index = 0; index < 20; index += 1) {
      await orcaPage.getByLabel('Zoom out').click()
    }
    for (const profile of [PROFILES.desktop, PROFILES.notebook]) {
      await orcaPage.setViewportSize(profile)
      await revealSurfaceAtReadableScale(
        orcaPage,
        browserSurface,
        profile.id === 'desktop' ? 560 : 440
      )
      await expect(
        browserSurface.locator(`img[data-browser-page-id="${browserPageId}"]`)
      ).toBeVisible()
      evidenceFiles.push(await capture(orcaPage, 'mtp-browser-exact', profile))
    }
    writeManifest({
      files: evidenceFiles,
      metrics: {
        platform: 'linux-electron',
        profiles: [PROFILES.desktop, PROFILES.notebook],
        browserPageId
      }
    })
  } finally {
    await browserProof.close()
  }
})

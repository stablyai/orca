import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test as base, expect } from './helpers/orca-app'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { focusActiveTerminalInput, waitForTerminalOutput } from './helpers/terminal'
import { RuntimeClient } from '../../src/cli/runtime-client'
import { publishAuthenticatedHarness } from './fixtures/maestro-workspace-tab-canvas/coordinator-bridge'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  PROFILES,
  activateNormalTab,
  capture,
  createAnnotation,
  createCanvasResource,
  openMaestro,
  prepareEvidence,
  removeWorkspaceResources,
  setTheme,
  startProofPage,
  stopProofPage
} from './fixtures/maestro-workspace-tab-canvas/evidence'

const FAULT_FILE = path.join(os.tmpdir(), `orca-mwc-authority-fault-${process.pid}`)
const test = base.extend({
  orcaAppExtraEnv: {
    ORCA_E2E_MWC_QUERY_DELAY_MS: '1200',
    ORCA_E2E_MWC_AUTHORITY_FAULT_FILE: FAULT_FILE
  }
})
const CHECKPOINTS = ['resize', 'browser', 'zoom', 'lifecycle', 'links', 'unavailable'] as const

test.describe('Maestro workspace Canvas in Electron', () => {
  for (const profile of PROFILES) {
    for (const checkpoint of CHECKPOINTS) {
      test(`@mwc-${checkpoint} proves workspace Canvas at ${profile.id}`, async ({
        orcaPage,
        testRepoPath,
        electronApp
      }) => {
        test.setTimeout(600_000)
        prepareEvidence(FAULT_FILE)
        const proof = await startProofPage()
        let cleanupHarness = async (): Promise<void> => {}
        try {
          await orcaPage.setViewportSize({ width: profile.width, height: profile.height })
          await waitForSessionReady(orcaPage)
          await waitForActiveWorktree(orcaPage)
          const scope = await openMaestro(orcaPage)
          const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
          const runtimeClient = new RuntimeClient(userDataDir, 30_000, null, null)
          const persistedZoomPercent = async (): Promise<number | null> => {
            const response = await runtimeClient.call<{
              status: string
              canvas?: { document: { viewport?: { zoom: number } } }
            }>('maestro.workspaceCanvas.get', {
              execution_host_id: scope.host,
              workspace_key: scope.workspace
            })
            return response.result.status === 'available' &&
              response.result.canvas?.document.viewport
              ? Math.round(response.result.canvas.document.viewport.zoom * 100)
              : null
          }
          await expect(orcaPage.getByText('Loading workspace resources…')).toBeVisible()
          if (checkpoint === 'resize') {
            await capture(orcaPage, 'loading', profile)
          }
          await expect(orcaPage.locator('[data-maestro-workspace-canvas]')).toBeVisible({
            timeout: 30_000
          })
          await expect
            .poll(() => orcaPage.locator('[data-tab-id]:not([data-pinned="true"])').count(), {
              timeout: 30_000
            })
            .toBeGreaterThan(0)
          await activateNormalTab(orcaPage)
          expect((await openMaestro(orcaPage)).id).toBe(scope.id)
          await removeWorkspaceResources(orcaPage)
          await expect(orcaPage.getByText('No workspace resources yet')).toBeVisible({
            timeout: 30_000
          })
          await expect(
            orcaPage.getByText('A Harness Run is optional.', { exact: false })
          ).toBeVisible()
          if (checkpoint === 'resize') {
            await capture(orcaPage, 'no-tabs', profile)
            const canvasBackground = orcaPage.locator(
              '[data-maestro-workspace-canvas] [data-slot="context-menu-trigger"]'
            )
            await canvasBackground.click({ button: 'right', position: { x: 16, y: 16 } })
            await expect(orcaPage.getByText('Add to canvas', { exact: true })).toBeVisible()
            await capture(orcaPage, 'context-menu-open', profile)
            await orcaPage.keyboard.press('Escape')
          }

          await createCanvasResource(orcaPage, 'terminal')
          const surfaces = orcaPage.locator('[data-maestro-workspace-surface]')
          await expect(surfaces).toHaveCount(1, { timeout: 30_000 })
          if (checkpoint === 'resize') {
            await capture(orcaPage, 'populated-no-run', profile)
            await surfaces.first().getByRole('button', { name: 'Focus exact tab' }).click()
            const terminalSurfaceKey = await surfaces
              .first()
              .getAttribute('data-maestro-workspace-surface')
            const terminalTabId = terminalSurfaceKey
              ? (JSON.parse(terminalSurfaceKey) as [string, string, string])[2]
              : null
            expect(terminalTabId).toBeTruthy()
            await expect
              .poll(() =>
                orcaPage.evaluate(() => {
                  const state = window.__store?.getState()
                  return { id: state?.activeTabId ?? null, type: state?.activeTabType ?? null }
                })
              )
              .toEqual({ id: terminalTabId, type: 'terminal' })
            await focusActiveTerminalInput(orcaPage)
            await orcaPage.keyboard.type("printf 'MWC_REAL_PTY_OUTPUT\\n'")
            await orcaPage.keyboard.press('Enter')
            await waitForTerminalOutput(orcaPage, 'MWC_REAL_PTY_OUTPUT', 30_000)
            await openMaestro(orcaPage)
            await expect(surfaces.first()).toContainText('MWC_REAL_PTY_OUTPUT')
            await setTheme(orcaPage, 'dark')
            await expect(orcaPage.getByLabel('Tab title')).toHaveCount(0)
            await capture(orcaPage, 'terminal-normal', profile)
            await surfaces.first().locator('header').click()
            await expect(orcaPage.getByLabel('Tab title')).toHaveCount(0)
            await expect(surfaces.first()).toContainText('Terminal')
            await capture(orcaPage, 'terminal-focused', profile)
            const beforeResize = await surfaces.first().boundingBox()
            const resizeHandle = await surfaces
              .first()
              .getByRole('button', { name: /^Resize / })
              .boundingBox()
            const canvasBox = await orcaPage
              .locator('[data-maestro-workspace-canvas]')
              .boundingBox()
            expect(resizeHandle).not.toBeNull()
            expect(canvasBox).not.toBeNull()
            if (!resizeHandle || !canvasBox) {
              throw new Error('Canvas resize geometry is unavailable')
            }
            const resizeStart = {
              x: resizeHandle.x + resizeHandle.width / 2,
              y: resizeHandle.y + resizeHandle.height / 2
            }
            const resizeEnd = {
              x: Math.min(resizeStart.x + 120, canvasBox.x + canvasBox.width - 20),
              y: Math.min(resizeStart.y + 80, canvasBox.y + canvasBox.height - 20)
            }
            await orcaPage.mouse.move(resizeStart.x, resizeStart.y)
            await orcaPage.mouse.down()
            await orcaPage.mouse.move(resizeEnd.x, resizeEnd.y, { steps: 6 })
            await orcaPage.mouse.up()
            const afterResize = await surfaces.first().boundingBox()
            expect(afterResize?.width ?? 0).toBeGreaterThan(beforeResize?.width ?? 0)
            expect(afterResize?.height ?? 0).toBeGreaterThan(beforeResize?.height ?? 0)
            await capture(orcaPage, 'terminal-resized', profile)
            const restoreHandle = await surfaces
              .first()
              .getByRole('button', { name: /^Resize / })
              .boundingBox()
            expect(restoreHandle).not.toBeNull()
            if (!restoreHandle) {
              throw new Error('Restored Canvas resize geometry is unavailable')
            }
            const restoreStart = {
              x: restoreHandle.x + restoreHandle.width / 2,
              y: restoreHandle.y + restoreHandle.height / 2
            }
            await orcaPage.mouse.move(restoreStart.x, restoreStart.y)
            await orcaPage.mouse.down()
            await orcaPage.mouse.move(
              restoreStart.x - (resizeEnd.x - resizeStart.x),
              restoreStart.y - (resizeEnd.y - resizeStart.y),
              { steps: 6 }
            )
            await orcaPage.mouse.up()
            await expect
              .poll(async () => (await surfaces.first().boundingBox())?.width ?? 0)
              .toBeLessThan(afterResize?.width ?? Number.POSITIVE_INFINITY)
            return
          }

          await setTheme(orcaPage, 'light')
          await createCanvasResource(orcaPage, 'browser')
          await expect(surfaces).toHaveCount(2, { timeout: 30_000 })
          const browserSurfaceIndex = await surfaces.evaluateAll((nodes) => {
            const state = window.__store?.getState()
            const worktreeId = state?.activeWorktreeId
            const tabs = worktreeId ? (state?.unifiedTabsByWorktree[worktreeId] ?? []) : []
            return nodes.findIndex((node) => {
              const key = node.getAttribute('data-maestro-workspace-surface')
              const unifiedTabId = key ? (JSON.parse(key) as [string, string, string])[2] : null
              return tabs.some((tab) => tab.id === unifiedTabId && tab.contentType === 'browser')
            })
          })
          expect(browserSurfaceIndex).toBeGreaterThanOrEqual(0)
          const browserSurface = surfaces.nth(browserSurfaceIndex)
          const browserSurfaceKey = await browserSurface.getAttribute(
            'data-maestro-workspace-surface'
          )
          const browserTabId = browserSurfaceKey
            ? (JSON.parse(browserSurfaceKey) as [string, string, string])[2]
            : null
          expect(browserTabId).toBeTruthy()
          const browserPageId = await browserSurface.getAttribute('data-maestro-browser-page-id')
          if (!browserPageId) {
            throw new Error('Exact Browser page identity was not rendered')
          }
          const focusBrowserPage = async (surface: typeof surfaces, pageId: string) => {
            await surface.getByRole('button', { name: 'Focus exact tab' }).click()
            const pagePane = orcaPage.locator(
              `[data-browser-page-pane-id="${pageId}"][aria-hidden="false"]`
            )
            await expect(pagePane).toBeVisible({ timeout: 30_000 })
            const overlay = orcaPage
              .locator('[data-browser-overlay-tab-id]')
              .filter({ has: pagePane })
            await expect(overlay).toHaveCount(1)
            const addressBar = pagePane.locator('[data-orca-browser-address-bar="true"]')
            const webview = overlay.locator('webview')
            await expect(addressBar).toBeVisible()
            await expect(webview).toHaveCount(1)
            return { addressBar, webview }
          }
          const exactBrowser = await focusBrowserPage(browserSurface, browserPageId)
          await exactBrowser.addressBar.fill(proof.url)
          await expect(exactBrowser.addressBar).toHaveValue(proof.url)
          await exactBrowser.addressBar.press('Enter')
          await expect
            .poll(
              () =>
                exactBrowser.webview.evaluate((node) =>
                  (node as Electron.WebviewTag).executeJavaScript(
                    'document.querySelector("h1")?.textContent'
                  )
                ),
              { timeout: 30_000 }
            )
            .toBe('MWC exact Browser page')
          await openMaestro(orcaPage, true)
          const targetSurface = orcaPage.locator(
            `[data-maestro-workspace-tab-id="${browserTabId}"]`
          )
          await expect(targetSurface).toBeVisible({
            timeout: 30_000
          })
          const beforeDecoyCreate = await surfaces.count()
          await createCanvasResource(orcaPage, 'browser')
          await expect(surfaces).toHaveCount(beforeDecoyCreate + 1, { timeout: 30_000 })
          const browserSurfaces = orcaPage.locator(
            '[data-maestro-workspace-content-type="browser"]'
          )
          await expect(browserSurfaces).toHaveCount(2, { timeout: 30_000 })
          const decoySurface = orcaPage.locator(
            `[data-maestro-workspace-content-type="browser"]:not([data-maestro-workspace-tab-id="${browserTabId}"])`
          )
          await expect(decoySurface).toHaveCount(1)
          const decoyPageId = await decoySurface.getAttribute('data-maestro-browser-page-id')
          if (!decoyPageId) {
            throw new Error('Distinct Browser decoy page identity was not found')
          }
          const decoyBrowser = await focusBrowserPage(decoySurface, decoyPageId)
          await decoyBrowser.addressBar.fill(proof.decoyUrl)
          await decoyBrowser.addressBar.press('Enter')
          await expect(decoyBrowser.addressBar).toHaveValue(proof.decoyUrl)
          await expect
            .poll(
              () =>
                decoyBrowser.webview.evaluate((node) =>
                  (node as Electron.WebviewTag).executeJavaScript(
                    'document.querySelector("h1")?.textContent'
                  )
                ),
              { timeout: 30_000 }
            )
            .toBe('MWC decoy Browser page')
          await openMaestro(orcaPage, true)
          await orcaPage.getByLabel('Fit resources').click()
          await expect(targetSurface).toHaveCount(1)
          const reopenedExactBrowser = await focusBrowserPage(targetSurface, browserPageId)
          await expect(reopenedExactBrowser.addressBar).toHaveValue(proof.url)
          await expect
            .poll(
              () =>
                reopenedExactBrowser.webview.evaluate((node) =>
                  (node as Electron.WebviewTag).executeJavaScript(
                    'document.querySelector("h1")?.textContent'
                  )
                ),
              { timeout: 30_000 }
            )
            .toBe('MWC exact Browser page')
          await openMaestro(orcaPage, true)
          await decoySurface.getByRole('button', { name: 'Close exact tab' }).click()
          await expect(surfaces).toHaveCount(beforeDecoyCreate, { timeout: 30_000 })
          await expect(targetSurface).toBeVisible()
          if (checkpoint === 'browser') {
            await orcaPage.getByLabel('Fit resources').click()
            await expect(targetSurface.locator('img[data-browser-page-id]')).toBeVisible({
              timeout: 30_000
            })
            await capture(orcaPage, 'browser-rendered', profile)
          }

          const contentPath = path.join(testRepoPath, 'MWC-EVIDENCE.md')
          writeFileSync(
            contentPath,
            '# Exact editor content\n\nWorkspace-owned recognizable content.\n'
          )
          await orcaPage.getByRole('button', { name: 'Refresh Explorer' }).click()
          await orcaPage.getByText('MWC-EVIDENCE.md', { exact: true }).dblclick()
          await expect(orcaPage.getByText('Exact editor content', { exact: false })).toBeVisible()
          await openMaestro(orcaPage, true)
          await expect(orcaPage.getByText('Workspace-owned recognizable content.')).toBeVisible({
            timeout: 30_000
          })
          await setTheme(orcaPage, 'dark')
          if (checkpoint === 'browser') {
            await orcaPage.getByLabel('Fit resources').click()
            const contentSurface = orcaPage.locator(
              '[data-maestro-workspace-content-type="editor"]'
            )
            await expect(contentSurface.locator('pre')).toContainText(
              'Workspace-owned recognizable content.',
              { timeout: 30_000 }
            )
            await expect(targetSurface.locator('img[data-browser-page-id]')).toBeVisible({
              timeout: 30_000
            })
            await capture(orcaPage, 'content-rendered', profile)
            return
          }
          await createAnnotation(orcaPage, 'Decision: preserve exact workspace tabs')
          const beforeCreate = await surfaces.count()
          await createAnnotation(orcaPage, 'Warning: receipt identity must remain exact')
          await expect(surfaces).toHaveCount(beforeCreate + 1)
          await setTheme(orcaPage, 'light')
          await createAnnotation(orcaPage, 'Blocked: authority conflict requires retry')
          await createAnnotation(orcaPage, 'Observation: exact surfaces remain live')
          const annotationInspector = orcaPage.locator('aside').filter({
            has: orcaPage.getByLabel('Tab title')
          })
          if (await annotationInspector.isVisible().catch(() => false)) {
            await annotationInspector
              .getByRole('button', { name: 'Close', exact: true })
              .dispatchEvent('click')
            await expect(annotationInspector).toBeHidden()
          }
          await orcaPage.getByLabel('Fit resources').click()
          const zoomReadout = orcaPage
            .getByLabel('Zoom out')
            .locator('xpath=following-sibling::span[1]')
          const fittedZoomPercent = Number.parseInt((await zoomReadout.textContent()) ?? '0', 10)
          await expect.poll(persistedZoomPercent).toBe(fittedZoomPercent)
          for (let step = 0; step < 10; step += 1) {
            const currentZoom = Number.parseInt((await zoomReadout.textContent()) ?? '0', 10)
            if (currentZoom >= 65) {
              break
            }
            await orcaPage.getByLabel('Zoom in').click()
            await expect.poll(persistedZoomPercent).toBeGreaterThan(currentZoom)
            const persistedZoom = await persistedZoomPercent()
            await expect
              .poll(async () => Number.parseInt((await zoomReadout.textContent()) ?? '0', 10))
              .toBe(persistedZoom)
          }
          const evidenceZoom = await zoomReadout.textContent()
          const evidenceZoomPercent = Number.parseInt(evidenceZoom ?? '0', 10)
          expect(evidenceZoomPercent).toBeGreaterThanOrEqual(65)
          await expect.poll(persistedZoomPercent).toBe(evidenceZoomPercent)
          await activateNormalTab(orcaPage)
          await openMaestro(orcaPage, true)
          await expect(zoomReadout).toHaveText(evidenceZoom ?? '')
          if (checkpoint === 'zoom') {
            await capture(orcaPage, 'annotation-tones', profile)
            return
          }
          if (checkpoint === 'unavailable') {
            const harness = await publishAuthenticatedHarness({
              page: orcaPage,
              userDataDir,
              scope,
              browserPageId,
              browserUrl: proof.url
            })
            cleanupHarness = harness.cleanup
            await openMaestro(orcaPage, true)
            const progress = orcaPage.getByRole('complementary', {
              name: new RegExp(`Harness run ${harness.runId}`)
            })
            await expect(progress).toBeVisible({ timeout: 30_000 })
            await orcaPage.getByLabel('Fit resources').click()
            writeFileSync(FAULT_FILE, 'unavailable')
            const unavailableBanner = orcaPage.getByText(
              'Authority unavailable. Last-known resources remain unverifiable.'
            )
            await expect(unavailableBanner).toBeVisible({ timeout: 30_000 })
            const [progressBox, bannerBox] = await Promise.all([
              progress.boundingBox(),
              unavailableBanner.boundingBox()
            ])
            expect(progressBox).not.toBeNull()
            expect(bannerBox).not.toBeNull()
            const overlaps =
              progressBox !== null &&
              bannerBox !== null &&
              progressBox.x < bannerBox.x + bannerBox.width &&
              progressBox.x + progressBox.width > bannerBox.x &&
              progressBox.y < bannerBox.y + bannerBox.height &&
              progressBox.y + progressBox.height > bannerBox.y
            expect(overlaps).toBe(false)
            await setTheme(orcaPage, 'dark')
            await capture(orcaPage, 'unavailable', profile)
            return
          }
          if (checkpoint === 'lifecycle') {
            const selected = surfaces.filter({
              has: orcaPage.locator('[data-annotation-tone="warning"]')
            })
            await expect(selected).toHaveCount(1)
            const selectedSurfaceKey = await selected.getAttribute('data-maestro-workspace-surface')
            const selectedTabId = selectedSurfaceKey
              ? (JSON.parse(selectedSurfaceKey) as [string, string, string])[2]
              : null
            expect(selectedTabId).toBeTruthy()
            await setTheme(orcaPage, 'dark')

            await selected.getByRole('button', { name: 'Focus exact tab' }).click()
            await expect
              .poll(() =>
                orcaPage.evaluate(() => {
                  const state = window.__store?.getState()
                  const worktreeId = state?.activeWorktreeId
                  const groupId = worktreeId
                    ? state?.activeGroupIdByWorktree[worktreeId]
                    : undefined
                  const group = worktreeId
                    ? state?.groupsByWorktree[worktreeId]?.find((item) => item.id === groupId)
                    : undefined
                  return { id: group?.activeTabId ?? null, type: state?.activeTabType ?? null }
                })
              )
              .toEqual({ id: selectedTabId, type: 'editor' })
            await openMaestro(orcaPage, true)
            await expect(selected).toHaveCount(1, { timeout: 30_000 })
            const beforeClose = await surfaces.count()
            await selected.getByRole('button', { name: 'Close exact tab' }).click()
            await expect(surfaces).toHaveCount(beforeClose - 1)
            await setTheme(orcaPage, 'light')
            return
          }

          const manualLinkSource = browserSurface
          const manualLinkTarget = surfaces.first()
          const [linkHandleBox, linkTargetBox] = await Promise.all([
            manualLinkSource.getByRole('button', { name: /Drag a link from/ }).boundingBox(),
            manualLinkTarget.boundingBox()
          ])
          expect(linkHandleBox).not.toBeNull()
          expect(linkTargetBox).not.toBeNull()
          if (!linkHandleBox || !linkTargetBox) {
            throw new Error('Manual-link drag geometry is unavailable')
          }
          await orcaPage.mouse.move(
            linkHandleBox.x + linkHandleBox.width / 2,
            linkHandleBox.y + linkHandleBox.height / 2
          )
          await orcaPage.mouse.down()
          await orcaPage.mouse.move(
            linkTargetBox.x + linkTargetBox.width / 2,
            linkTargetBox.y + linkTargetBox.height / 2,
            { steps: 8 }
          )
          await expect(manualLinkTarget).toHaveAttribute('data-maestro-link-target', 'true')
          await orcaPage.mouse.up()
          const linkInspector = orcaPage.locator('aside').filter({
            has: orcaPage.getByLabel('Tab title')
          })
          const manualPaths = orcaPage.locator('[data-link-provenance="manual"]')
          await expect(manualPaths).toHaveCount(1, { timeout: 30_000 })
          await manualLinkTarget.getByRole('button', { name: 'Rename tab' }).click()
          await expect(linkInspector.getByText('Manual', { exact: true })).toHaveCount(1)
          await expect(linkInspector.getByText('Suggestion', { exact: true }).first()).toBeVisible()
          await linkInspector
            .getByRole('button', { name: 'Close', exact: true })
            .dispatchEvent('click')
          await expect(linkInspector).toBeHidden()
          await capture(orcaPage, 'links-manual', profile)
          const harness = await publishAuthenticatedHarness({
            page: orcaPage,
            userDataDir,
            scope,
            browserPageId,
            browserUrl: proof.url
          })
          cleanupHarness = harness.cleanup
          await openMaestro(orcaPage, true)
          await expect(orcaPage.locator(`[data-tab-id="${harness.workerTabId}"]`)).toBeVisible()
          await expect(orcaPage.locator('[data-link-provenance="automatic"]')).toBeVisible({
            timeout: 30_000
          })
          await browserSurface.getByRole('button', { name: 'Rename tab' }).click()
          const suggestions = linkInspector.locator('.rounded-md').filter({ hasText: 'Suggestion' })
          const suggestionCount = await suggestions.count()
          expect(suggestionCount).toBeGreaterThanOrEqual(2)
          await suggestions.first().getByRole('button', { name: 'Accept' }).click()
          await expect(suggestions).toHaveCount(suggestionCount - 1)
          await suggestions.first().getByRole('button', { name: 'Hide' }).click()
          await expect(suggestions).toHaveCount(suggestionCount - 2)
          await capture(orcaPage, 'links-automatic-suggested', profile)
          const progress = orcaPage.getByRole('complementary', {
            name: new RegExp(`Harness run ${harness.runId}`)
          })
          await expect(progress).toContainText('Active')
          await expect(progress).toContainText('Done')
          await expect(progress).toContainText('Running')
          await expect(progress).toContainText('Pending')
          await expect(progress).toContainText('Next')
          await expect(progress).toContainText('Blocked')
          await expect(progress).toContainText('MWC-NEXT')
          await expect(progress).toContainText('MWC-BLOCKED')
          await expect(linkInspector).toBeVisible()
          const [progressBox, inspectorBox] = await Promise.all([
            progress.boundingBox(),
            linkInspector.boundingBox()
          ])
          expect(progressBox).not.toBeNull()
          expect(inspectorBox).not.toBeNull()
          const overlaps =
            progressBox !== null &&
            inspectorBox !== null &&
            progressBox.x < inspectorBox.x + inspectorBox.width &&
            progressBox.x + progressBox.width > inspectorBox.x &&
            progressBox.y < inspectorBox.y + inspectorBox.height &&
            progressBox.y + progressBox.height > inspectorBox.y
          expect(overlaps).toBe(false)
          await linkInspector
            .getByRole('button', { name: 'Close', exact: true })
            .dispatchEvent('click')
          await expect(linkInspector).toBeHidden()
          await capture(orcaPage, 'progress-all-states', profile)
        } finally {
          await cleanupHarness()
          rmSync(FAULT_FILE, { force: true })
          await stopProofPage(proof.server)
        }
      })
    }

    // oxlint-disable-next-line no-empty-pattern -- This journey owns both Electron launches through createRestartSession.
    test(`@mwc-restart persists workspace Canvas at ${profile.id}`, async ({}, testInfo) => {
      test.setTimeout(300_000)
      prepareEvidence(FAULT_FILE)
      const repoPath = existsSync(TEST_REPO_PATH_FILE)
        ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
        : ''
      test.skip(!repoPath || !existsSync(repoPath), 'Seeded E2E repo is unavailable')
      const session = createRestartSession(testInfo)
      let firstApp: ElectronApplication | null = null
      let secondApp: ElectronApplication | null = null
      try {
        const first = await session.launch()
        firstApp = first.app
        await first.page.setViewportSize({ width: profile.width, height: profile.height })
        await waitForSessionReady(first.page)
        await attachRepoAndOpenTerminal(first.page, repoPath)
        const restartScope = await openMaestro(first.page)
        const firstUserDataDir = await first.app.evaluate(({ app }) => app.getPath('userData'))
        const restartClient = new RuntimeClient(firstUserDataDir, 30_000, null, null)
        const restartZoomPercent = async (): Promise<number | null> => {
          const response = await restartClient.call<{
            status: string
            canvas?: { document: { viewport?: { zoom: number } } }
          }>('maestro.workspaceCanvas.get', {
            execution_host_id: restartScope.host,
            workspace_key: restartScope.workspace
          })
          return response.result.status === 'available' && response.result.canvas?.document.viewport
            ? Math.round(response.result.canvas.document.viewport.zoom * 100)
            : null
        }
        await createAnnotation(first.page, 'decision', 'Restart persistence decision')
        await first.page.getByLabel('Zoom in').click()
        await expect.poll(restartZoomPercent).toBe(115)
        await first.page.getByLabel('Zoom in').click()
        await expect.poll(restartZoomPercent).toBe(132)
        await expect(first.page.getByText('132%')).toBeVisible()
        await activateNormalTab(first.page)
        await openMaestro(first.page)
        await expect(first.page.getByText('132%')).toBeVisible()
        await session.close(firstApp)
        firstApp = null

        const second = await session.launch()
        secondApp = second.app
        await second.page.setViewportSize({ width: profile.width, height: profile.height })
        await waitForSessionReady(second.page)
        await waitForActiveWorktree(second.page)
        await openMaestro(second.page)
        await expect(second.page.getByText('Restart persistence decision')).toBeVisible()
        await expect(second.page.getByText('132%')).toBeVisible()
        await capture(second.page, 'restart-persistence', profile)
      } finally {
        for (const app of [secondApp, firstApp]) {
          if (app) {
            await session.close(app).catch(() => {})
          }
        }
        await session.dispose()
      }
    })

    // oxlint-disable-next-line no-empty-pattern -- This journey owns both Electron launches through createRestartSession.
    test(`@mwc-terminal-preload restores every Canvas terminal at ${profile.id}`, async ({}, testInfo) => {
      test.setTimeout(300_000)
      prepareEvidence(FAULT_FILE)
      const repoPath = existsSync(TEST_REPO_PATH_FILE)
        ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
        : ''
      test.skip(!repoPath || !existsSync(repoPath), 'Seeded E2E repo is unavailable')
      const session = createRestartSession(testInfo)
      let firstApp: ElectronApplication | null = null
      let secondApp: ElectronApplication | null = null
      const expectedTerminalCount = 6
      try {
        const first = await session.launch()
        firstApp = first.app
        await first.page.setViewportSize({ width: profile.width, height: profile.height })
        await waitForSessionReady(first.page)
        await attachRepoAndOpenTerminal(first.page, repoPath)
        await openMaestro(first.page, true)
        const firstTerminalSurfaces = first.page.locator(
          '[data-maestro-workspace-content-type="terminal"]'
        )
        for (
          let count = await firstTerminalSurfaces.count();
          count < expectedTerminalCount;
          count++
        ) {
          await createCanvasResource(first.page, 'terminal')
          await expect(firstTerminalSurfaces).toHaveCount(count + 1, { timeout: 30_000 })
        }
        await session.close(firstApp)
        firstApp = null

        const second = await session.launch()
        secondApp = second.app
        await second.page.setViewportSize({ width: profile.width, height: profile.height })
        await waitForSessionReady(second.page)
        await waitForActiveWorktree(second.page)
        await openMaestro(second.page, true)
        await expect(
          second.page.locator('[data-maestro-workspace-content-type="terminal"]')
        ).toHaveCount(expectedTerminalCount, { timeout: 30_000 })
        await second.page.getByLabel('Fit resources').click()
        await expect(second.page.locator('[data-terminal-preview-mode="canvas"]')).toHaveCount(
          expectedTerminalCount,
          { timeout: 30_000 }
        )
        await capture(second.page, 'terminal-preload', profile)
      } finally {
        for (const app of [secondApp, firstApp]) {
          if (app) {
            await session.close(app).catch(() => {})
          }
        }
        await session.dispose()
      }
    })
  }
})

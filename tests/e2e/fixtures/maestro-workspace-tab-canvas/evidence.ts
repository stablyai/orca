import { createServer, type Server } from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { expect, type Page } from '@stablyai/playwright-test'

export const EVIDENCE_DIR = path.resolve('.visual-evidence/maestro-workspace-tab-canvas')
export const PROFILES = [
  { id: 'desktop', width: 1920, height: 1080 },
  { id: 'notebook', width: 1366, height: 768 }
] as const
export type EvidenceProfile = (typeof PROFILES)[number]
export type MaestroScope = { id: string; host: string; workspace: string }

export function prepareEvidence(faultFile: string): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  rmSync(faultFile, { force: true })
}

export function activeWorkspaceTabContentType(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const groupId = worktreeId ? state?.activeGroupIdByWorktree?.[worktreeId] : null
    const group = worktreeId
      ? state?.groupsByWorktree?.[worktreeId]?.find((item) => item.id === groupId)
      : null
    const active = worktreeId
      ? state?.unifiedTabsByWorktree?.[worktreeId]?.find((tab) => tab.id === group?.activeTabId)
      : null
    return active?.contentType ?? null
  })
}

export async function openMaestro(page: Page, waitForCanvas = false): Promise<MaestroScope> {
  const maestro = page.locator('button[data-tab-id][aria-label="Maestro"]')
  await expect(maestro).toHaveCount(1)
  await expect(maestro).toHaveAttribute('data-pinned', 'true')
  const tabs = page.locator('button[data-tab-id]')
  await expect(tabs.first()).toHaveAttribute('aria-label', 'Maestro')
  const maestroTabId = await maestro.getAttribute('data-tab-id')
  expect(maestroTabId).toBeTruthy()
  await maestro.click()
  if (waitForCanvas) {
    await expect.poll(() => activeWorkspaceTabContentType(page)).toBe('maestro')
    await expect(page.locator('[data-maestro-workspace-canvas]')).toBeVisible()
  }
  const scope = await page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tab = worktreeId
      ? state?.unifiedTabsByWorktree[worktreeId]?.find((item) => item.contentType === 'maestro')
      : null
    return tab?.maestroExecutionHostId && tab.maestroWorkspaceKey
      ? { id: tab.id, host: tab.maestroExecutionHostId, workspace: tab.maestroWorkspaceKey }
      : null
  })
  if (!scope) {
    throw new Error('Maestro did not bind the active workspace')
  }
  return scope
}

export async function removeWorkspaceResources(page: Page): Promise<void> {
  const surfaces = page.locator('[data-maestro-workspace-surface]')
  await expect.poll(() => surfaces.count(), { timeout: 30_000 }).toBeGreaterThan(0)
  while (await surfaces.count()) {
    const before = await surfaces.count()
    await surfaces.first().getByRole('button', { name: 'Close exact tab' }).click()
    const confirm = page.getByRole('button', { name: 'Confirm', exact: true })
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click()
    }
    await expect(surfaces).toHaveCount(before - 1, { timeout: 30_000 })
  }
}

export async function activateNormalTab(page: Page): Promise<void> {
  const tab = page.locator('[data-tab-id]:not([data-pinned="true"])').first()
  await expect(tab).toBeVisible()
  await tab.click()
}

export async function capture(page: Page, state: string, profile: EvidenceProfile): Promise<void> {
  await page.setViewportSize({ width: profile.width, height: profile.height })
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, `mwc-${state}-${profile.id}.png`),
    animations: 'disabled',
    caret: 'hide',
    scale: 'css'
  })
}

export async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => window.__store?.getState().updateSettings({ theme: value }), theme)
  await expect(page.locator('html')).toHaveClass(new RegExp(theme))
}

export async function createCanvasResource(
  page: Page,
  resource: 'terminal' | 'browser' | 'annotation'
): Promise<void> {
  const background = page.locator(
    '[data-maestro-workspace-canvas] > [data-slot="context-menu-trigger"]'
  )
  await background.click({ button: 'right', position: { x: 16, y: 16 }, force: true })
  if (resource === 'terminal') {
    await page.getByRole('menuitem', { name: 'Terminal', exact: true }).hover()
    await page.getByRole('menuitem', { name: 'Normal shell', exact: true }).dispatchEvent('click')
    return
  }
  await page
    .getByRole('menuitem', {
      name: resource === 'browser' ? 'Browser' : 'New annotation',
      exact: true
    })
    .dispatchEvent('click')
}

export async function createAnnotation(page: Page, text: string): Promise<void> {
  const surfaces = page.locator('[data-maestro-workspace-surface]')
  const before = await surfaces.count()
  const existingKeys = await surfaces.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-maestro-workspace-surface'))
  )
  await createCanvasResource(page, 'annotation')
  await expect(surfaces).toHaveCount(before + 1, { timeout: 30_000 })
  let annotationIndex = -1
  await expect
    .poll(async () => {
      annotationIndex = await surfaces.evaluateAll((nodes, knownKeys) => {
        const known = new Set(knownKeys)
        return nodes.findIndex(
          (node) => !known.has(node.getAttribute('data-maestro-workspace-surface'))
        )
      }, existingKeys)
      return annotationIndex
    })
    .toBeGreaterThanOrEqual(0)
  const annotation = surfaces.nth(annotationIndex)
  await page.getByLabel('Fit resources').click()
  const rename = annotation.getByRole('button', { name: 'Rename tab' })
  await expect(rename).toBeVisible()
  await rename.click()
  const titleInput = annotation.getByRole('textbox', { name: 'Tab title' })
  await titleInput.fill(text)
  await titleInput.press('Enter')
  await expect(titleInput).toBeHidden()
  const editor = annotation.getByLabel('Edit annotation')
  await editor.fill(`${text}\n\nEditable directly in Canvas.`)
  await expect(annotation).toContainText('Editable directly in Canvas.', { timeout: 30_000 })
}

export async function startProofPage(): Promise<{ server: Server; url: string; decoyUrl: string }> {
  const server = createServer((request, response) => {
    const decoy = request.url === '/mwc-decoy'
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(
      decoy
        ? '<!doctype html><html><body><main><h1>MWC decoy Browser page</h1></main></body></html>'
        : '<!doctype html><html><body style="margin:0;font:16px system-ui"><main style="padding:28px"><h1>MWC exact Browser page</h1><p>Existing page captured from its real Orca Browser surface.</p></main></body></html>'
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Proof server address unavailable')
  }
  const origin = `http://127.0.0.1:${address.port}`
  return { server, url: `${origin}/mwc-proof`, decoyUrl: `${origin}/mwc-decoy` }
}

export async function stopProofPage(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
}

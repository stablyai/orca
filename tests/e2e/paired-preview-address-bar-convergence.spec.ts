import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient,
  type RuntimeDesktopPairingOffer
} from './helpers/paired-electron-client'
import { startClientHostedMarkerFixture } from './helpers/client-hosted-browser-fixture'
import {
  readDocPreviewGuestUrl,
  readDocPreviewRenderedText,
  readPairedHtmlPreviewInventory,
  requireSingleDocWorkspace
} from './helpers/paired-html-preview-inventory'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const FIXTURE_NAME = 'convergence-doc.html'
const FIXTURE_HEADING = 'address bar convergence'
const FIXTURE_TITLE = 'Convergence Document'

type PreparedPairedClient = {
  client: PairedElectronClient
  worktreeId: string
  worktreePath: string
}

async function preparePairedClient(
  offer: RuntimeDesktopPairingOffer,
  testInfo: TestInfo,
  testRepoPath: string
): Promise<PreparedPairedClient> {
  const client = await launchPairedElectronClient(offer, testInfo, 'Address-bar convergence')
  try {
    // Use workstation width so split-preview document chips retain clickable pixels under CI.
    await client.page.setViewportSize({ width: 1600, height: 900 })
    await expect
      .poll(
        () =>
          client.page.evaluate(
            (repoPath) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .find((worktree) => worktree.path === repoPath)?.id ?? null,
            testRepoPath
          ),
        { timeout: 120_000, message: 'paired client never received the host worktree' }
      )
      .not.toBeNull()
    const worktree = await client.page.evaluate((repoPath) => {
      const match = window.__store
        ?.getState()
        .allWorktrees()
        .find((candidate) => candidate.path === repoPath)
      return match ? { id: match.id, path: match.path } : null
    }, testRepoPath)
    if (!worktree) {
      throw new Error('paired client worktree disappeared after discovery')
    }
    await client.page.evaluate(
      ({ environmentId, worktreeId }) => {
        window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { environmentId: client.environmentId, worktreeId: worktree.id }
    )
    return { client, worktreeId: worktree.id, worktreePath: worktree.path }
  } catch (error) {
    await client.dispose()
    throw error
  }
}

// Use the canonical new-tab path: raw paired create can race adoption and duplicate the host page.
async function openPairedWebTab(page: Page, url: string): Promise<void> {
  await page.evaluate(async (pageUrl) => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      throw new Error('Paired client has no active worktree')
    }
    const groupId = state.activeGroupIdByWorktree[state.activeWorktreeId]
    if (!groupId) {
      throw new Error('Paired client has no active tab group')
    }
    state.setBrowserDefaultUrl(pageUrl)
    await state.openNewBrowserTabInActiveWorkspace(groupId)
  }, url)
}

async function openPreviewFromExplorer(page: Page, fixtureName: string): Promise<void> {
  await openFileExplorer(page)
  const fixtureRow = page.locator('[data-file-explorer-row]').filter({ hasText: fixtureName })
  await expect(fixtureRow).toBeVisible({ timeout: 30_000 })
  await fixtureRow.click()
  const openPreviewToSide = page.getByRole('button', { name: 'Open Preview to the Side' })
  await expect(openPreviewToSide).toBeVisible({ timeout: 30_000 })
  await openPreviewToSide.click()
}

// STA-5681: drive preview chip → URL conversion → Back/Forward → document conversion and document-name suggestions.
// Converted tabs retain client-local ownership, so host session snapshots stay empty.
test('converts a preview to a web tab and back from the address bar', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  writeFileSync(
    path.join(testRepoPath, FIXTURE_NAME),
    `<!doctype html><html><head><title>${FIXTURE_TITLE}</title></head>` +
      `<body><h1>${FIXTURE_HEADING}</h1></body></html>\n`
  )
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)

  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const marker = await startClientHostedMarkerFixture()
  let prepared: PreparedPairedClient | null = null
  try {
    prepared = await preparePairedClient(offer, testInfo, testRepoPath)
    const { client, worktreeId, worktreePath } = prepared
    const page = client.page
    const docFilePath = path.join(worktreePath, FIXTURE_NAME)
    const inventoryArgs = { environmentId: client.environmentId, docFilePath, worktreeId }

    await openPreviewFromExplorer(page, FIXTURE_NAME)
    await expect
      .poll(
        async () =>
          (await readPairedHtmlPreviewInventory(page, inventoryArgs)).docWorkspaces.length,
        { timeout: 60_000, message: 'the document browser tab never materialized' }
      )
      .toBe(1)
    await expect
      .poll(() => readDocPreviewRenderedText(page, 'h1'), { timeout: 60_000 })
      .toContain(FIXTURE_HEADING)
    const preview = requireSingleDocWorkspace(
      await readPairedHtmlPreviewInventory(page, inventoryArgs)
    )
    await page.locator(`[data-tab-id="${preview.workspaceId}"]`).click()

    // The mobile-publish baseline: the document tab is held back from the tab snapshot.
    const baseline = await readPairedHtmlPreviewInventory(page, inventoryArgs)
    expect(baseline.hostSessionBrowserTabs).toHaveLength(0)

    // Click the file icon at the chip’s left edge; narrow-pane center hits the neighboring tooltip.
    await page
      .getByRole('button', { name: 'Edit address', exact: true })
      .click({ position: { x: 8, y: 10 } })
    const addressInput = page.locator('[data-browser-chrome-address-slot] input')
    await expect(addressInput).toBeVisible({ timeout: 10_000 })
    await expect(addressInput).toHaveValue(FIXTURE_NAME)

    // Convert in place with the preview’s client-local ownership; desktop-host publish behavior is pinned in sync-runtime-graph-conversion-publish.test.ts.
    await addressInput.fill(marker.markerUrl)
    await addressInput.press('Enter')
    await expect
      .poll(
        async () => {
          const inventory = await readPairedHtmlPreviewInventory(page, inventoryArgs)
          return {
            docWorkspaces: inventory.docWorkspaces.length,
            publishedTabs: inventory.hostSessionBrowserTabs.length
          }
        },
        { timeout: 60_000, message: 'the conversion never reached the store' }
      )
      .toEqual({ docWorkspaces: 0, publishedTabs: 0 })
    const converted = await page.evaluate(
      ({ targetWorktreeId, workspaceId }) => {
        const state = window.__store?.getState()
        const workspace = (state?.browserTabsByWorktree[targetWorktreeId] ?? []).find(
          (tab) => tab.id === workspaceId
        )
        const pages = state?.browserPagesByWorkspace[workspaceId] ?? []
        return workspace
          ? {
              url: workspace.url,
              docLocation: workspace.docLocation ?? null,
              convertedFrom: pages[0]?.convertedFrom ?? null
            }
          : null
      },
      { targetWorktreeId: worktreeId, workspaceId: preview.workspaceId }
    )
    expect(converted?.url).toBe(marker.markerUrl)
    expect(converted?.docLocation).toBeNull()
    expect(converted?.convertedFrom).toMatchObject({ kind: 'workspace-doc' })
    await expect
      .poll(() => page.locator('webview').last().getAttribute('src'), { timeout: 30_000 })
      .toContain(marker.origin)

    // Back's one-level return: the guest has no history, so Back crosses the conversion.
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await readPairedHtmlPreviewInventory(page, inventoryArgs)).docWorkspaces.length,
        { timeout: 60_000, message: 'Back never returned across the conversion' }
      )
      .toBe(1)
    await expect
      .poll(() => readDocPreviewRenderedText(page, 'h1'), { timeout: 60_000 })
      .toContain(FIXTURE_HEADING)
    await expect.poll(() => readDocPreviewGuestUrl(page)).toMatch(/^orca-preview:\/\//)

    // Forward rebuilds the consumed client-local web target; runtime-owned origins remain unsupported because conversion closed their remote page (STA-5872).
    await page.getByRole('button', { name: 'Forward', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await readPairedHtmlPreviewInventory(page, inventoryArgs)).docWorkspaces.length,
        { timeout: 60_000, message: 'Forward never re-crossed the conversion' }
      )
      .toBe(0)
    await expect
      .poll(() => page.locator('webview').last().getAttribute('src'), { timeout: 30_000 })
      .toContain(marker.origin)
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await readPairedHtmlPreviewInventory(page, inventoryArgs)).docWorkspaces.length,
        { timeout: 60_000, message: 'Back after Forward never returned across the conversion' }
      )
      .toBe(1)
    await expect
      .poll(() => readDocPreviewRenderedText(page, 'h1'), { timeout: 60_000 })
      .toContain(FIXTURE_HEADING)

    // Reverse from web to document, then require the web toolbar’s Forward to re-cross after Back.
    await page.getByRole('button', { name: 'Forward', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await readPairedHtmlPreviewInventory(page, inventoryArgs)).docWorkspaces.length,
        { timeout: 60_000, message: 'the second Forward never re-crossed the conversion' }
      )
      .toBe(0)
    // Click the input slot to expand its zero-width field before typing (#11090).
    const convertedAddressSlot = page.locator('[data-browser-chrome-address-slot]')
    await expect(convertedAddressSlot).toBeVisible({ timeout: 30_000 })
    await convertedAddressSlot.click()
    const convertedAddressInput = convertedAddressSlot.locator('input')
    await expect(convertedAddressInput).toBeVisible({ timeout: 30_000 })
    await convertedAddressInput.fill(docFilePath)
    await convertedAddressInput.press('Enter')
    await expect
      .poll(
        async () =>
          (await readPairedHtmlPreviewInventory(page, inventoryArgs)).docWorkspaces.length,
        { timeout: 60_000, message: 'the typed path never converted the client-local web tab' }
      )
      .toBe(1)
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await readPairedHtmlPreviewInventory(page, inventoryArgs)).docWorkspaces.length,
        { timeout: 60_000, message: 'Back never restored the typed-over web page' }
      )
      .toBe(0)
    await expect
      .poll(() => page.locator('webview').last().getAttribute('src'), { timeout: 30_000 })
      .toContain(marker.origin)
    await page.getByRole('button', { name: 'Forward', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await readPairedHtmlPreviewInventory(page, inventoryArgs)).docWorkspaces.length,
        { timeout: 60_000, message: "the web toolbar's Forward never re-crossed to the document" }
      )
      .toBe(1)
    await expect
      .poll(() => readDocPreviewRenderedText(page, 'h1'), { timeout: 60_000 })
      .toContain(FIXTURE_HEADING)

    const returned = requireSingleDocWorkspace(
      await readPairedHtmlPreviewInventory(page, inventoryArgs)
    )
    await page.evaluate((workspaceId) => {
      window.__store?.getState().closeBrowserTab(workspaceId)
    }, returned.workspaceId)
    await openPairedWebTab(page, marker.markerUrl)
    const webAddressInput = page.locator('[data-browser-chrome-address-slot] input')
    await expect(webAddressInput).toBeVisible({ timeout: 30_000 })
    await webAddressInput.fill(docFilePath)
    await webAddressInput.press('Enter')
    await expect
      .poll(
        async () =>
          (await readPairedHtmlPreviewInventory(page, inventoryArgs)).docWorkspaces.length,
        { timeout: 60_000, message: 'the typed path never converted the web tab' }
      )
      .toBe(1)
    await expect
      .poll(() => readDocPreviewRenderedText(page, 'h1'), { timeout: 60_000 })
      .toContain(FIXTURE_HEADING)

    // Selecting the document identity must activate its existing tab, preserving its grant.
    const docTabsBefore = (await readPairedHtmlPreviewInventory(page, inventoryArgs)).docWorkspaces
    await openPairedWebTab(page, marker.movedUrl)
    // Wait for the old converted pane to unmount or strict input locators see both.
    await expect
      .poll(() => page.locator('[data-browser-chrome-address-slot] input').count(), {
        timeout: 30_000,
        message: 'the web tab address input never settled to one'
      })
      .toBe(1)
    const secondInput = page.locator('[data-browser-chrome-address-slot] input')
    // Retry expansion if the freshly loaded guest steals focus and dismisses the dropdown.
    await expect
      .poll(
        async () => {
          await secondInput.click()
          return secondInput.getAttribute('aria-expanded')
        },
        { timeout: 30_000, message: 'the suggestion dropdown never opened' }
      )
      .toBe('true')
    await secondInput.pressSequentially('Convergence', { delay: 40 })
    // Scope to the suggestion popover so the existing strip title cannot satisfy the locator.
    const docSuggestion = page
      .locator('[data-slot="popover-content"]')
      .getByText(FIXTURE_TITLE, { exact: false })
      .first()
    await expect(docSuggestion).toBeVisible({ timeout: 10_000 })
    await docSuggestion.click()
    await expect
      .poll(
        async () => {
          const inventory = await readPairedHtmlPreviewInventory(page, inventoryArgs)
          const activeWorkspaceId = await page.evaluate(
            (targetWorktreeId) =>
              window.__store?.getState().activeBrowserTabIdByWorktree[targetWorktreeId] ?? null,
            worktreeId
          )
          return { docTabs: inventory.docWorkspaces.length, activeWorkspaceId }
        },
        { timeout: 30_000, message: 'selecting the doc suggestion did not activate the doc tab' }
      )
      .toEqual({
        docTabs: docTabsBefore.length,
        activeWorkspaceId: docTabsBefore[0]?.workspaceId ?? null
      })
  } finally {
    await marker.close()
    await prepared?.client.dispose()
  }
})

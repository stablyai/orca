import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { createRestartSession } from './helpers/orca-restart'

// Why: mirrors FLOATING_TERMINAL_WORKTREE_ID in src/shared/constants.ts.
// E2E specs avoid importing renderer/shared modules into the Playwright runner.
const FLOATING_WORKTREE_ID = 'global-floating-terminal'
const OPEN_PANEL_SELECTOR = '[data-floating-terminal-panel][aria-hidden="false"]'
const PANEL_SELECTOR = '[data-floating-terminal-panel]'

async function seedFloatingMarkdownFile(page: Page): Promise<{
  originalName: string
  originalPath: string
  intermediateName: string
  intermediatePath: string
  renamedName: string
  renamedPath: string
  tabId: string
}> {
  const directory = await page.evaluate(() => window.api.app.getFloatingMarkdownDirectory())
  const suffix = Date.now().toString(36)
  const originalName = `floating-rename-${suffix}.md`
  const intermediateName = `floating-entered-${suffix}.md`
  const renamedName = `floating-renamed-${suffix}.md`
  const originalPath = path.join(directory, originalName)
  const intermediatePath = path.join(directory, intermediateName)
  const renamedPath = path.join(directory, renamedName)
  const tabId = await page.evaluate(
    async ({ filePath, originalName, worktreeId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }

      await store.getState().updateSettings({ floatingTerminalEnabled: true })
      await window.api.fs.createFile({ filePath })
      await window.api.fs.writeFile({ filePath, content: '# Floating rename\n' })
      store.getState().openFile(
        {
          filePath,
          relativePath: originalName,
          worktreeId,
          language: 'markdown',
          mode: 'edit',
          runtimeEnvironmentId: null
        },
        { preview: false, suppressActiveRuntimeFallback: true }
      )

      const state = store.getState()
      const file = state.openFiles.find(
        (candidate) => candidate.filePath === filePath && candidate.worktreeId === worktreeId
      )
      const tab = state.unifiedTabsByWorktree[worktreeId]?.find(
        (candidate) => candidate.contentType === 'editor' && candidate.entityId === file?.id
      )
      if (!file || !tab) {
        throw new Error('Floating Markdown tab unavailable')
      }
      return tab.id
    },
    { filePath: originalPath, originalName, worktreeId: FLOATING_WORKTREE_ID }
  )
  return {
    originalName,
    originalPath,
    intermediateName,
    intermediatePath,
    renamedName,
    renamedPath,
    tabId
  }
}

async function openFloatingPanel(page: Page): Promise<void> {
  await page.waitForFunction(
    (selector) => Boolean(document.querySelector(selector)),
    PANEL_SELECTOR,
    { timeout: 30_000 }
  )
  // Why: the panel's open flag is persisted (floating-terminal-panel-view-state), so
  // after a restart it reopens on its own and a blind toggle would close it again.
  const alreadyOpen = await page.evaluate(
    (selector) => Boolean(document.querySelector(selector)),
    OPEN_PANEL_SELECTOR
  )
  if (!alreadyOpen) {
    await page.evaluate(() => window.dispatchEvent(new Event('orca-toggle-floating-terminal')))
  }
  await expect(page.locator(OPEN_PANEL_SELECTOR)).toBeVisible()
}

test('concurrent floating Markdown renames do not clobber the destination', async ({
  orcaPage
}) => {
  const directory = await orcaPage.evaluate(() => window.api.app.getFloatingMarkdownDirectory())
  const suffix = Date.now().toString(36)
  const firstPath = path.join(directory, `floating-first-${suffix}.md`)
  const secondPath = path.join(directory, `floating-second-${suffix}.md`)
  const destinationPath = path.join(directory, `floating-destination-${suffix}.md`)

  const result = await orcaPage.evaluate(
    async ({ firstPath, secondPath, destinationPath }) => {
      await window.api.fs.createFile({ filePath: firstPath })
      await window.api.fs.createFile({ filePath: secondPath })
      await window.api.fs.writeFile({ filePath: firstPath, content: 'first\n' })
      await window.api.fs.writeFile({ filePath: secondPath, content: 'second\n' })

      const settled = await Promise.allSettled([
        window.api.fs.rename({ oldPath: firstPath, newPath: destinationPath }),
        window.api.fs.rename({ oldPath: secondPath, newPath: destinationPath })
      ])
      const firstExists = await window.api.fs.pathExists({ filePath: firstPath })
      const secondExists = await window.api.fs.pathExists({ filePath: secondPath })
      return {
        statuses: settled.map(({ status }) => status).sort(),
        rejectionMessages: settled.flatMap((outcome) =>
          outcome.status === 'rejected' ? [String(outcome.reason)] : []
        ),
        destinationContent: (await window.api.fs.readFile({ filePath: destinationPath })).content,
        firstExists,
        secondExists,
        firstContent: firstExists
          ? (await window.api.fs.readFile({ filePath: firstPath })).content
          : null,
        secondContent: secondExists
          ? (await window.api.fs.readFile({ filePath: secondPath })).content
          : null
      }
    },
    { firstPath, secondPath, destinationPath }
  )

  expect(result.statuses).toEqual(['fulfilled', 'rejected'])
  expect(result.rejectionMessages[0]).toContain('already exists')
  expect(Number(result.firstExists) + Number(result.secondExists)).toBe(1)
  expect(
    [result.destinationContent, result.firstContent ?? result.secondContent].toSorted()
  ).toEqual(['first\n', 'second\n'])
})

test('Electron serializes native Unicode rename aliases', async ({ orcaPage }) => {
  test.skip(process.platform !== 'darwin', 'Requires native Unicode aliasing')
  const directory = await orcaPage.evaluate(() => window.api.app.getFloatingMarkdownDirectory())
  const suffix = Date.now().toString(36)
  const firstPath = path.join(directory, `floating-unicode-first-${suffix}.md`)
  const secondPath = path.join(directory, `floating-unicode-second-${suffix}.md`)
  const sharpSDestination = path.join(directory, `floating-destination-${suffix}-straße.md`)
  const expandedDestination = path.join(directory, `floating-destination-${suffix}-STRASSE.MD`)

  const result = await orcaPage.evaluate(
    async ({ firstPath, secondPath, sharpSDestination, expandedDestination }) => {
      await window.api.fs.createFile({ filePath: firstPath })
      await window.api.fs.createFile({ filePath: secondPath })
      await window.api.fs.writeFile({ filePath: firstPath, content: 'first\n' })
      await window.api.fs.writeFile({ filePath: secondPath, content: 'second\n' })

      const settled = await Promise.allSettled([
        window.api.fs.rename({ oldPath: firstPath, newPath: sharpSDestination }),
        window.api.fs.rename({ oldPath: secondPath, newPath: expandedDestination })
      ])
      const firstExists = await window.api.fs.pathExists({ filePath: firstPath })
      const secondExists = await window.api.fs.pathExists({ filePath: secondPath })
      return {
        statuses: settled.map(({ status }) => status).sort(),
        destinationContent: (await window.api.fs.readFile({ filePath: sharpSDestination })).content,
        firstExists,
        secondExists,
        remainingContent: firstExists
          ? (await window.api.fs.readFile({ filePath: firstPath })).content
          : (await window.api.fs.readFile({ filePath: secondPath })).content
      }
    },
    { firstPath, secondPath, sharpSDestination, expandedDestination }
  )

  expect(result.statuses).toEqual(['fulfilled', 'rejected'])
  expect(Number(result.firstExists) + Number(result.secondExists)).toBe(1)
  expect([result.destinationContent, result.remainingContent].toSorted()).toEqual([
    'first\n',
    'second\n'
  ])
})

test('floating workspace Markdown renames survive an app restart', async (// oxlint-disable-next-line no-empty-pattern -- This persistence test owns both Electron launches.
{}, testInfo) => {
  test.setTimeout(300_000)
  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null

  try {
    const first = await session.launch()
    firstApp = first.app
    await waitForSessionReady(first.page)
    const seeded = await seedFloatingMarkdownFile(first.page)
    await openFloatingPanel(first.page)

    const panel = first.page.locator(OPEN_PANEL_SELECTOR)
    const tab = panel.locator(`[data-tab-id="${seeded.tabId}"]`)
    await expect(tab).toContainText(seeded.originalName)
    await tab.click({ button: 'right' })
    const renameMenuItem = first.page.getByRole('menuitem').filter({ hasText: 'Rename' }).first()
    await expect(renameMenuItem).toBeVisible()
    await renameMenuItem.click()

    const enterInput = panel.getByRole('textbox', {
      name: `Rename file ${seeded.originalName}`,
      exact: true
    })
    await enterInput.fill(seeded.intermediateName)
    await enterInput.press('Enter')
    await expect(tab).toContainText(seeded.intermediateName)

    await tab.getByText(seeded.intermediateName, { exact: true }).dispatchEvent('dblclick')
    const blurInput = panel.getByRole('textbox', {
      name: `Rename file ${seeded.intermediateName}`,
      exact: true
    })
    await blurInput.fill(seeded.renamedName)
    await panel.getByRole('radio', { name: 'Rich Editor' }).click()
    await expect(tab).toContainText(seeded.renamedName)
    await expect
      .poll(() =>
        first.page.evaluate(
          async ({ renamedPath, originalPath, intermediatePath }) => ({
            content: (await window.api.fs.readFile({ filePath: renamedPath })).content,
            originalExists: await window.api.fs.pathExists({ filePath: originalPath }),
            intermediateExists: await window.api.fs.pathExists({ filePath: intermediatePath })
          }),
          {
            renamedPath: seeded.renamedPath,
            originalPath: seeded.originalPath,
            intermediatePath: seeded.intermediatePath
          }
        )
      )
      .toEqual({
        content: '# Floating rename\n',
        originalExists: false,
        intermediateExists: false
      })

    await session.close(firstApp)
    firstApp = null

    const second = await session.launch()
    secondApp = second.app
    await waitForSessionReady(second.page)
    await openFloatingPanel(second.page)

    const restoredPanel = second.page.locator(OPEN_PANEL_SELECTOR)
    const restoredTab = restoredPanel.locator('[data-tab-id]').filter({
      hasText: seeded.renamedName
    })
    await expect(restoredTab).toContainText(seeded.renamedName)
    await expect
      .poll(() =>
        second.page.evaluate(
          async ({ renamedPath, originalPath, intermediatePath, worktreeId }) => {
            const file = window.__store
              ?.getState()
              .openFiles.find(
                (candidate) =>
                  candidate.worktreeId === worktreeId && candidate.filePath === renamedPath
              )
            return {
              restoredPath: file?.filePath ?? null,
              content: (await window.api.fs.readFile({ filePath: renamedPath })).content,
              originalExists: await window.api.fs.pathExists({ filePath: originalPath }),
              intermediateExists: await window.api.fs.pathExists({ filePath: intermediatePath })
            }
          },
          {
            renamedPath: seeded.renamedPath,
            originalPath: seeded.originalPath,
            intermediatePath: seeded.intermediatePath,
            worktreeId: FLOATING_WORKTREE_ID
          }
        )
      )
      .toEqual({
        restoredPath: seeded.renamedPath,
        content: '# Floating rename\n',
        originalExists: false,
        intermediateExists: false
      })
  } finally {
    for (const app of [secondApp, firstApp]) {
      if (!app) {
        continue
      }
      try {
        await session.close(app)
      } catch {
        // best-effort cleanup
      }
    }
    await session.dispose()
  }
})

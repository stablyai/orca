import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { waitForSessionReady } from '../../desktop/renderer-probes/store'
import {
  activateGoldenWorktree,
  cleanupGoldenWorktree,
  createGoldenWorktree
} from '../../golden-journeys/golden-source-control'

const CARD = 'src/Card.tsx'

async function openTypeScriptFile(page: Page, relativePath: string): Promise<void> {
  await page.evaluate((fileRelativePath) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const worktree = Object.values(state?.worktreesByRepo ?? {})
      .flat()
      .find((entry) => entry.id === worktreeId)
    if (!state || !worktreeId || !worktree) {
      throw new Error('No active worktree')
    }
    const separator = worktree.path.includes('\\') ? '\\' : '/'
    state.openFile({
      filePath: `${worktree.path}${separator}${fileRelativePath.split('/').join(separator)}`,
      relativePath: fileRelativePath,
      worktreeId,
      language: 'typescript',
      mode: 'edit'
    })
  }, relativePath)
}

// Monaco merges same-colored tokens into one span, so locate the text by its range.
async function textCenter(page: Page, lineText: string, text: string) {
  const point = await page.evaluate(
    ({ lineText, text }) => {
      for (const line of document.querySelectorAll('.monaco-editor .view-line')) {
        if (!line.textContent?.replace(/ /g, ' ').includes(lineText)) {
          continue
        }
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const index = node.textContent?.indexOf(text) ?? -1
          if (index === -1) {
            continue
          }
          const range = document.createRange()
          range.setStart(node, index)
          range.setEnd(node, index + text.length)
          const rect = range.getBoundingClientRect()
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        }
      }
      return null
    },
    { lineText, text }
  )
  if (!point) {
    throw new Error(`No rendered "${text}" on the line containing "${lineText}"`)
  }
  return point
}

test('renames the matching JSX closing tag while the opening tag name is edited', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = createGoldenWorktree(testRepoPath, 'jsx-linked-editing')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  const filePath = path.join(fixture.worktreePath, CARD)
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(
    filePath,
    'export function Card() {\n  return <div className="card">{1 < 2 && <span>hi</span>}</div>\n}\n'
  )

  await waitForSessionReady(orcaPage)
  await activateGoldenWorktree(orcaPage, testRepoPath, fixture.worktreePath)
  await orcaPage.evaluate(() =>
    window.__store?.getState().updateSettings({ editorLinkedEditing: true })
  )
  await openTypeScriptFile(orcaPage, CARD)
  const editorLines = orcaPage.locator('.monaco-editor .view-lines')
  await expect(editorLines).toContainText('</div>', { timeout: 25_000 })

  const tagName = await textCenter(orcaPage, 'return <div', 'div')
  await orcaPage.mouse.dblclick(tagName.x, tagName.y)
  // Linked ranges are computed by the TypeScript worker after the cursor settles.
  await expect
    .poll(
      () =>
        orcaPage.evaluate(
          () => document.querySelectorAll('.monaco-editor .linked-editing-decoration').length
        ),
      { timeout: 15_000 }
    )
    .toBeGreaterThan(0)
  await orcaPage.keyboard.type('section')

  await expect(editorLines).toContainText('<section className="card">', { timeout: 10_000 })
  await expect(editorLines).toContainText('</span>}</section>', { timeout: 10_000 })
})

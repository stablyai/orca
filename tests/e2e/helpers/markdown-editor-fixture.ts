import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Locator, Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

const MARKDOWN_HYDRATION_TIMEOUT_MS = 25_000

export type ActiveWorktreeContext = {
  worktreeId: string
  rootPath: string
}

export type ActiveEditorFile = {
  filePath: string
}

export async function getActiveWorktreeContext(page: Page): Promise<ActiveWorktreeContext> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      throw new Error('No active worktree is selected')
    }

    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.id === worktreeId)
    if (!worktree) {
      throw new Error(`Active worktree was not found in store: ${worktreeId}`)
    }

    return { worktreeId, rootPath: worktree.path }
  })
}

export async function createMarkdownFixture(
  context: ActiveWorktreeContext,
  directoryName: string,
  slug: string,
  workerIndex: number,
  initialMarkdown: string
): Promise<string> {
  const directory = path.join(context.rootPath, directoryName)
  await mkdir(directory, { recursive: true })

  const filePath = path.join(directory, `${slug}-${workerIndex}-${Date.now()}-${randomUUID()}.md`)
  await writeFile(filePath, initialMarkdown, 'utf8')

  return filePath
}

export async function cleanupMarkdownFixture(filePath: string | null): Promise<void> {
  if (!filePath) {
    return
  }

  try {
    await rm(filePath, { force: true })
  } catch {
    // Best-effort cleanup must not hide the editor regression assertion.
  }
}

export async function openMarkdownFixture(
  page: Page,
  context: ActiveWorktreeContext,
  filePath: string
): Promise<ActiveEditorFile> {
  const relativePath = path.relative(context.rootPath, filePath)

  await page.evaluate(
    ({ filePath, relativePath, worktreeId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }

      store.getState().openFile({
        filePath,
        relativePath,
        worktreeId,
        language: 'markdown',
        mode: 'edit'
      })
    },
    { filePath, relativePath, worktreeId: context.worktreeId }
  )

  let activeFile: ActiveEditorFile | null = null
  await expect
    .poll(
      async () => {
        activeFile = await page.evaluate(() => {
          const store = window.__store
          if (!store) {
            return null
          }

          const state = store.getState()
          const file = state.openFiles.find((entry) => entry.id === state.activeFileId)
          return file ? { filePath: file.filePath } : null
        })
        return activeFile?.filePath ?? null
      },
      {
        timeout: 5_000,
        message: `Active editor file did not become ${filePath}`
      }
    )
    .toBe(filePath)

  if (!activeFile) {
    throw new Error(`Active editor file was not available after opening ${filePath}`)
  }

  return activeFile
}

export async function waitForRichMarkdownEditor(page: Page): Promise<Locator> {
  const editor = page.locator('.rich-markdown-editor')
  await expect(editor).toBeVisible({ timeout: MARKDOWN_HYDRATION_TIMEOUT_MS })
  return editor
}

export async function closeActiveEditorTab(page: Page, filePath: string): Promise<void> {
  const fileName = path.basename(filePath)
  const tab = page.locator('[data-tab-id]').filter({ hasText: fileName }).last()
  await tab.getByRole('button', { name: 'Close tab' }).click()

  await expect(page.locator('.editor-header-path').filter({ hasText: fileName })).toHaveCount(0, {
    timeout: 10_000
  })
}

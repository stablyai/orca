// After relaunch, preserve deliberately empty/editor-only workspaces and seed a terminal only when a never-opened workspace is shown.
// Main’s terminal rows must give the same answer with or without window tab saves.

import path from 'node:path'
import { writeFileSync } from 'node:fs'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { switchToWorktree, waitForSessionReady } from './helpers/store'

type WorkspaceTabs = { terminals: number; editors: number }

async function createWorktree(page: Page, name: string): Promise<string> {
  return page.evaluate(async (worktreeName) => {
    const state = window.__store!.getState()
    const repoId = state.allWorktrees()[0]?.repoId
    if (!repoId) {
      throw new Error('seed repo was not loaded')
    }
    return (await state.createWorktree(repoId, worktreeName, undefined, 'skip')).worktree.id
  }, name)
}

async function workspaceTabs(page: Page, worktreeId: string): Promise<WorkspaceTabs> {
  return page.evaluate((id) => {
    const state = window.__store!.getState()
    const entries = state.unifiedTabsByWorktree[id] ?? []
    return {
      terminals: (state.tabsByWorktree[id] ?? []).length,
      editors: entries.filter((entry) => entry.contentType === 'editor').length
    }
  }, worktreeId)
}

async function waitForTabs(page: Page, worktreeId: string, expected: WorkspaceTabs) {
  await expect.poll(() => workspaceTabs(page, worktreeId), { timeout: 30_000 }).toEqual(expected)
}

async function closeTerminals(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((id) => {
    const state = window.__store!.getState()
    for (const tab of state.tabsByWorktree[id] ?? []) {
      state.closeTab(tab.id)
    }
  }, worktreeId)
}

async function openEditor(
  page: Page,
  worktreeId: string,
  filePath: string,
  readOnly?: true
): Promise<void> {
  await page.evaluate(
    ({ id, file, readOnly }) => {
      window.__store!.getState().openFile({
        filePath: file,
        relativePath: file.split('/').pop()!,
        worktreeId: id,
        language: 'plaintext',
        mode: 'edit',
        ...(readOnly ? { readOnly } : {})
      })
    },
    { id: worktreeId, file: filePath, readOnly }
  )
}

async function isReadOnly(page: Page, filePath: string): Promise<boolean | null> {
  return page.evaluate(
    (file) =>
      window.__store!.getState().openFiles.find((open) => open.filePath === file)?.readOnly ?? null,
    filePath
  )
}

async function worktreePath(page: Page, worktreeId: string): Promise<string> {
  return page.evaluate(
    (id) =>
      window
        .__store!.getState()
        .allWorktrees()
        .find((worktree) => worktree.id === id)!.path,
    worktreeId
  )
}

// The editor-only workspace's file also opens read-only, then again for editing: a relaunch
// restores it editable, as the reopen left it.
test('a relaunch seeds only a workspace that was never opened', async ({
  testRepoPath
}, testInfo) => {
  const session = createRestartSession(testInfo)
  const refusals: string[] = []
  const watch = (page: Page) =>
    page.on('console', (message) => {
      if (/\[layout-owner\].*(refused|failed)/.test(message.text())) {
        refusals.push(message.text())
      }
    })
  let app: Awaited<ReturnType<typeof session.launch>>['app'] | undefined
  try {
    const first = await session.launch()
    app = first.app
    watch(first.page)
    await waitForSessionReady(first.page)
    await attachRepoAndOpenTerminal(first.page, testRepoPath)
    const stamp = Date.now()
    const emptied = await createWorktree(first.page, `relaunch-emptied-${stamp}`)
    const editorOnly = await createWorktree(first.page, `relaunch-editor-${stamp}`)
    const neverOpened = await createWorktree(first.page, `relaunch-never-${stamp}`)

    await switchToWorktree(first.page, emptied)
    await waitForTabs(first.page, emptied, { terminals: 1, editors: 0 })
    await closeTerminals(first.page, emptied)
    await waitForTabs(first.page, emptied, { terminals: 0, editors: 0 })

    await switchToWorktree(first.page, editorOnly)
    await waitForTabs(first.page, editorOnly, { terminals: 1, editors: 0 })
    const notes = path.join(await worktreePath(first.page, editorOnly), 'relaunch-notes.txt')
    writeFileSync(notes, 'notes\n')
    await openEditor(first.page, editorOnly, notes, true)
    await expect.poll(() => isReadOnly(first.page, notes)).toBe(true)
    await openEditor(first.page, editorOnly, notes)
    await expect.poll(() => isReadOnly(first.page, notes)).toBe(null)
    await closeTerminals(first.page, editorOnly)
    await waitForTabs(first.page, editorOnly, { terminals: 0, editors: 1 })
    // Long enough for the window's debounced save and main's commands to land.
    await first.page.waitForTimeout(2_000)
    await session.close(app)
    app = undefined

    const second = await session.launch()
    app = second.app
    watch(second.page)
    await waitForSessionReady(second.page)
    for (const worktreeId of [emptied, editorOnly, neverOpened]) {
      await switchToWorktree(second.page, worktreeId)
      // A first terminal is created shortly after a workspace is shown, or not at all.
      await second.page.waitForTimeout(3_000)
    }
    await waitForTabs(second.page, neverOpened, { terminals: 1, editors: 0 })
    expect(await workspaceTabs(second.page, emptied)).toEqual({ terminals: 0, editors: 0 })
    expect(await workspaceTabs(second.page, editorOnly)).toEqual({ terminals: 0, editors: 1 })
    expect(await isReadOnly(second.page, notes)).toBe(null)
    expect(refusals).toEqual([])
  } finally {
    await session.dispose(app)
  }
})

/**
 * Invariant: the built-in workspace Notes panel keeps drafts isolated to the
 * selected Git worktree or folder workspace and persists through its save path.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type WorkspaceIds = {
  first: string
  second: string
}

async function selectWorkspace(page: Page, workspaceId: string): Promise<void> {
  await page.evaluate((id) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    if (id.startsWith('folder:')) {
      store.getState().setActiveFolderWorkspace(id.slice('folder:'.length), 'local')
      return
    }
    store.getState().setActiveWorktree(id, 'local')
  }, workspaceId)
}

async function openNotesPanel(page: Page): Promise<void> {
  const notesButton = page.getByRole('button', { name: 'Notes', exact: true })
  await expect(notesButton).toBeVisible({ timeout: 15_000 })
  await notesButton.click({ force: true })
  await expect(page.getByRole('textbox', { name: 'Workspace note' })).toBeVisible()
}

async function getTwoGitWorktreeIds(page: Page): Promise<WorkspaceIds> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('window.__store is not available')
    }
    const worktrees = Object.values(state.worktreesByRepo).flat()
    const first =
      worktrees.find((worktree) => worktree.id === state.activeWorktreeId) ?? worktrees[0]
    const second = worktrees.find((worktree) => worktree.id !== first?.id)
    if (!first || !second) {
      throw new Error('The E2E fixture must provide two Git worktrees')
    }
    return { first: first.id, second: second.id }
  })
}

async function createTwoFolderWorkspaceIds(
  page: Page,
  parentPath: string
): Promise<WorkspaceIds & { groupId: string }> {
  return page.evaluate(async (folderPath) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const group = await window.api.projectGroups.create({
      name: `Notes E2E ${Date.now()}`,
      parentPath: folderPath,
      createdFrom: 'manual'
    })
    await store.getState().fetchProjectGroups()
    const first = await store.getState().createFolderWorkspace({
      projectGroupId: group.id,
      name: 'Folder workspace A',
      folderPath
    })
    const second = await store.getState().createFolderWorkspace({
      projectGroupId: group.id,
      name: 'Folder workspace B',
      folderPath
    })
    if (!first || !second) {
      throw new Error('The folder workspace fixtures could not be created')
    }
    return { first: `folder:${first.id}`, second: `folder:${second.id}`, groupId: group.id }
  }, parentPath)
}

async function deleteFolderWorkspaceGroup(page: Page, groupId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await window.__store?.getState().deleteProjectGroup(id)
  }, groupId)
}

test.describe('Workspace Notes panel', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('keeps notes isolated and persistent across Git worktree switches', async ({ orcaPage }) => {
    const workspaces = await getTwoGitWorktreeIds(orcaPage)

    await selectWorkspace(orcaPage, workspaces.first)
    await openNotesPanel(orcaPage)

    const note = orcaPage.getByRole('textbox', { name: 'Workspace note' })
    const status = orcaPage.locator('span[role="status"][aria-live="polite"]')
    await note.fill('Workspace A reminder')
    await expect(status).toHaveText('Saved')

    await selectWorkspace(orcaPage, workspaces.second)
    await expect(note).toHaveValue('')
    await note.fill('Workspace B reminder')
    await expect(status).toHaveText('Saved')

    await selectWorkspace(orcaPage, workspaces.first)
    await expect(note).toHaveValue('Workspace A reminder')
    await selectWorkspace(orcaPage, workspaces.second)
    await expect(note).toHaveValue('Workspace B reminder')
  })

  test('keeps notes isolated and persistent across folder workspace switches', async ({
    orcaPage
  }) => {
    const parentPath = await mkdtemp(path.join(os.tmpdir(), 'orca-e2e-notes-folder-'))
    let groupId: string | null = null

    try {
      const workspaces = await createTwoFolderWorkspaceIds(orcaPage, parentPath)
      groupId = workspaces.groupId

      await selectWorkspace(orcaPage, workspaces.first)
      await openNotesPanel(orcaPage)

      const note = orcaPage.getByRole('textbox', { name: 'Workspace note' })
      const status = orcaPage.locator('span[role="status"][aria-live="polite"]')
      await note.fill('Folder A reminder')
      await expect(status).toHaveText('Saved')

      await selectWorkspace(orcaPage, workspaces.second)
      await expect(note).toHaveValue('')
      await note.fill('Folder B reminder')
      await expect(status).toHaveText('Saved')

      await selectWorkspace(orcaPage, workspaces.first)
      await expect(note).toHaveValue('Folder A reminder')
      await selectWorkspace(orcaPage, workspaces.second)
      await expect(note).toHaveValue('Folder B reminder')
    } finally {
      if (groupId) {
        await deleteFolderWorkspaceGroup(orcaPage, groupId).catch(() => undefined)
      }
      // Why: Windows watchers can briefly retain the fixture directory after teardown.
      await rm(parentPath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100
      }).catch(() => undefined)
    }
  })
})

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect } from './orca-app'
import type { PairedElectronClient } from './paired-electron-client'
import type { ProjectedWorktreeRoute } from './nested-runtime-ssh-client-route'
import { focusActiveTerminalInput, getTerminalContent } from './terminal'

type PairedClientLocalMutationCanary = {
  assertUntouched(): void
  dispose(): void
}

function createPairedClientLocalMutationCanary(
  worktreePath: string,
  directory: string,
  sourceName: string,
  renamedName: string,
  contents: string
): PairedClientLocalMutationCanary {
  // Why: a cross-routed nested mutation can touch this same absolute path on the paired client.
  const directoryPath = path.resolve(worktreePath, directory)
  const sourcePath = path.join(directoryPath, sourceName)
  const renamedPath = path.join(directoryPath, renamedName)
  const childPath = path.join(directoryPath, 'preserve-directory', 'child.txt')
  mkdirSync(path.dirname(childPath), { recursive: true })
  writeFileSync(sourcePath, contents)
  writeFileSync(childPath, contents)
  return {
    assertUntouched: () => {
      expect(readFileSync(sourcePath, 'utf8')).toBe(contents)
      expect(readFileSync(childPath, 'utf8')).toBe(contents)
      expect(existsSync(renamedPath)).toBe(false)
    },
    dispose: () => rmSync(directoryPath, { force: true, recursive: true })
  }
}

async function assertRemoteFilesystemMarker(
  client: PairedElectronClient,
  command: string,
  marker: string
): Promise<void> {
  await focusActiveTerminalInput(client.page)
  await client.page.keyboard.insertText(`${command} && printf '${marker}\\n'`)
  await client.page.keyboard.press('Enter')
  await expect.poll(() => getTerminalContent(client.page), { timeout: 15_000 }).toContain(marker)
}

export async function assertNestedFilesystemRoute(
  client: PairedElectronClient,
  route: ProjectedWorktreeRoute,
  options: { onRenamed?: (absolutePath: string) => void | Promise<void> } = {}
): Promise<void> {
  if (!route.runtimeOwnerEnvironmentId) {
    throw new Error(`Worktree ${route.worktreeId} has no runtime transport owner`)
  }
  const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  const directory = `orca-nested-route-${suffix}`
  const sourceName = 'source.txt'
  const renamedName = 'renamed.txt'
  const marker = `nested-files-seeded-${suffix}`
  const localCanary = createPairedClientLocalMutationCanary(
    route.worktreePath,
    directory,
    sourceName,
    renamedName,
    `paired-client-local-${suffix}\n`
  )

  try {
    await focusActiveTerminalInput(client.page)
    await client.page.keyboard.insertText(
      `mkdir -p '${directory}' && printf 'nested-route-content\\n' > '${directory}/${sourceName}' && printf '${marker}\\n'`
    )
    await client.page.keyboard.press('Enter')
    await expect.poll(() => getTerminalContent(client.page), { timeout: 15_000 }).toContain(marker)

    await client.page.evaluate(() => {
      const state = window.__store?.getState()
      state?.setRightSidebarTab('explorer')
      state?.setRightSidebarOpen(true)
    })
    const explorer = client.page.locator('[data-orca-explorer-shell]')
    await expect(explorer).toBeVisible({ timeout: 15_000 })
    const row = (name: string) =>
      explorer.locator('[data-file-explorer-row]').filter({ hasText: name }).first()
    await explorer.getByRole('button', { name: 'Refresh Explorer' }).click()
    await expect(row(directory)).toBeVisible({ timeout: 30_000 })
    await row(directory).click()
    await expect(row(sourceName)).toBeVisible({ timeout: 30_000 })

    await row(sourceName).click()
    await expect(client.page.locator('.editor-header-path').first()).toContainText(sourceName, {
      timeout: 20_000
    })
    await expect(client.page.locator('.view-lines').first()).toContainText('nested-route-content', {
      timeout: 20_000
    })

    await row(sourceName).getByText(sourceName, { exact: true }).dblclick()
    const inlineInput = explorer.locator('input').last()
    await inlineInput.fill(renamedName)
    await inlineInput.press('Enter')
    await expect(row(renamedName)).toBeVisible({ timeout: 15_000 })
    await expect(row(sourceName)).toHaveCount(0)
    await assertRemoteFilesystemMarker(
      client,
      `[ ! -e '${directory}/${sourceName}' ] && [ -f '${directory}/${renamedName}' ]`,
      `nested-rename-confirmed-${suffix}`
    )
    localCanary.assertUntouched()
    await options.onRenamed?.(`${route.worktreePath}/${directory}/${renamedName}`)

    await row(renamedName).click()
    await client.page.keyboard.press('Delete')
    const fileDeleteDialog = client.page.locator('[role="dialog"]:visible').last()
    const fileDeleteButton = fileDeleteDialog.getByRole('button', { name: 'Delete', exact: true })
    await expect(fileDeleteButton).toBeEnabled()
    await fileDeleteButton.click({ force: true })
    await expect(fileDeleteDialog).toBeHidden()
    await expect(row(renamedName)).toHaveCount(0, { timeout: 15_000 })
    await assertRemoteFilesystemMarker(
      client,
      `[ ! -e '${directory}/${renamedName}' ]`,
      `nested-file-delete-confirmed-${suffix}`
    )
    localCanary.assertUntouched()

    await row(directory).click()
    await client.page.keyboard.press('Delete')
    const directoryDeleteDialog = client.page.locator('[role="dialog"]:visible').last()
    const directoryDeleteButton = directoryDeleteDialog.getByRole('button', {
      name: 'Delete',
      exact: true
    })
    await expect(directoryDeleteButton).toBeEnabled()
    await directoryDeleteButton.click({ force: true })
    await expect(directoryDeleteDialog).toBeHidden()
    await expect(row(directory)).toHaveCount(0, { timeout: 15_000 })
    await assertRemoteFilesystemMarker(
      client,
      `[ ! -e '${directory}' ]`,
      `nested-directory-delete-confirmed-${suffix}`
    )
    localCanary.assertUntouched()
  } finally {
    localCanary.dispose()
  }
}

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import {
  execDockerSshRelayTargetCommand,
  type DockerSshRelayTarget
} from './docker-ssh-relay-target'

async function assertCreatedFileRendered(
  page: Page,
  worktreeId: string,
  filePath: string
): Promise<void> {
  const fileName = path.basename(filePath)
  const fileId = await page.evaluate(
    ({ fileName, filePath, worktreeId }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Paired web store is unavailable')
      }
      state.openFile({
        filePath,
        relativePath: fileName,
        worktreeId,
        language: 'plaintext',
        mode: 'edit'
      })
      const file = window.__store
        ?.getState()
        .openFiles.find(
          (candidate) => candidate.filePath === filePath && candidate.worktreeId === worktreeId
        )
      if (!file) {
        throw new Error(`Paired web editor did not open ${filePath}`)
      }
      state.setActiveFile(file.id)
      state.setActiveTabType('editor')
      return file.id
    },
    { fileName, filePath, worktreeId }
  )

  await expect(page.locator('.editor-header-path').first()).toContainText(fileName, {
    timeout: 30_000
  })
  await page.evaluate((id) => {
    const state = window.__store?.getState()
    state?.closeFile(id)
    state?.setActiveTabType('terminal')
  }, fileId)
  await expect(page.locator('.editor-header-path').filter({ hasText: fileName })).toHaveCount(0)
}

async function assertPairedWebFilesystemMutations(
  page: Page,
  worktreeId: string,
  verifyCreated: (paths: { copiedPath: string; renamedPath: string }) => void,
  verifyDeleted: (directoryPath: string) => void
): Promise<void> {
  const worktree = await page.evaluate((id) => {
    const match = Object.values(window.__store?.getState().worktreesByRepo ?? {})
      .flat()
      .find((candidate) => candidate.id === id)
    if (!match) {
      throw new Error(`Paired web worktree ${id} is unavailable`)
    }
    return { hostId: match.hostId ?? 'local', path: match.path }
  }, worktreeId)
  const directory = `orca-web-mutation-${Date.now().toString(36)}`
  const join = worktree.hostId.startsWith('ssh:') ? path.posix.join : path.join
  const directoryPath = join(worktree.path, directory)
  const sourcePath = join(directoryPath, 'source.txt')
  const renamedPath = join(directoryPath, 'renamed.txt')
  const copiedPath = join(directoryPath, 'copied.txt')

  await page.evaluate(
    async ({ copiedPath, directoryPath, renamedPath, sourcePath }) => {
      await window.api.fs.createDir({ dirPath: directoryPath })
      await window.api.fs.createFile({ filePath: sourcePath })
      await window.api.fs.writeFile({ filePath: sourcePath, content: 'paired-web-content\n' })
      await window.api.fs.rename({ oldPath: sourcePath, newPath: renamedPath })
      await window.api.fs.copy({ sourcePath: renamedPath, destinationPath: copiedPath })
    },
    { copiedPath, directoryPath, renamedPath, sourcePath }
  )
  verifyCreated({ copiedPath, renamedPath })
  await assertCreatedFileRendered(page, worktreeId, renamedPath)

  await page.evaluate(
    async ({ copiedPath, directoryPath, renamedPath }) => {
      await window.api.fs.deletePath({ targetPath: copiedPath })
      await window.api.fs.deletePath({ targetPath: renamedPath })
      await window.api.fs.deletePath({ targetPath: directoryPath, recursive: true })
    },
    { copiedPath, directoryPath, renamedPath }
  )
  verifyDeleted(directoryPath)
}

export async function assertPairedWebLocalFilesystemMutations(
  page: Page,
  worktreeId: string
): Promise<void> {
  await assertPairedWebFilesystemMutations(
    page,
    worktreeId,
    ({ copiedPath, renamedPath }) => {
      expect(readFileSync(renamedPath, 'utf8')).toBe('paired-web-content\n')
      expect(readFileSync(copiedPath, 'utf8')).toBe('paired-web-content\n')
    },
    (directoryPath) => expect(existsSync(directoryPath)).toBe(false)
  )
}

export async function assertPairedWebSshFilesystemMutations(
  page: Page,
  worktreeId: string,
  target: DockerSshRelayTarget
): Promise<void> {
  await assertPairedWebFilesystemMutations(
    page,
    worktreeId,
    ({ copiedPath, renamedPath }) => {
      expect(
        execDockerSshRelayTargetCommand(
          target,
          `[ "$(cat '${renamedPath}')" = paired-web-content ] && [ "$(cat '${copiedPath}')" = paired-web-content ] && echo yes`
        )
      ).toBe('yes')
    },
    (directoryPath) => {
      expect(
        execDockerSshRelayTargetCommand(target, `[ ! -e '${directoryPath}' ] && echo yes`)
      ).toBe('yes')
    }
  )
}

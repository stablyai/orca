import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { serverCall } from './helpers/orcad-convert-flow'
import {
  launchConvertedProfile,
  skipUnlessManagedDockerHost,
  withManagedHost
} from './helpers/orcad-managed-workspace'
import { dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'
import { openFileExplorer } from './helpers/file-explorer'
import { openTerminalWorkspaceRootLink } from './helpers/terminal-workspace-root-link'
import { toRuntimeExecutionHostId } from '../../src/shared/execution-host'
import { getWorktreeHostIdentity } from '../../src/shared/worktree/host-qualified-identity'
import { quotePosixShell } from '../../src/shared/wsl-login-shell-command'

import {
  focusActiveTerminalInput,
  getTerminalContent,
  waitForActivePanePtyId
} from './helpers/terminal'

skipUnlessManagedDockerHost()
test.skip(process.platform === 'win32', 'Owned POSIX host collision fixture')

test('a managed terminal path link cannot switch to a desktop workspace at the same path', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(4 * 60_000)
  const fileName = 'COMMAND_FILE_OWNER.txt'
  const filePath = path.join(testRepoPath, fileName)
  writeFileSync(filePath, 'DESKTOP_COMMAND_FILE_OWNER\n')
  const intermediate = path.join(testRepoPath, 'intermediate-command-repo')
  mkdirSync(intermediate)
  execFileSync('git', ['init', '-q', intermediate])
  writeFileSync(path.join(intermediate, 'INTERMEDIATE_OWNER.txt'), 'INTERMEDIATE\n')
  await withManagedHost(testInfo, async (fixture) => {
    const { host } = fixture
    if (!host.exec) {
      throw new Error('Missing owned host control')
    }
    const execute = host.exec
    execute(
      `mkdir -p ${quotePosixShell(path.dirname(testRepoPath))} && git clone --quiet ${quotePosixShell(host.remoteRepoPath)} ${quotePosixShell(testRepoPath)} && printf 'REMOTE_COMMAND_FILE_OWNER\n' > ${quotePosixShell(filePath)}`
    )
    let ids: string[] = []
    const { page, seeded, environmentId } = await launchConvertedProfile(fixture, {
      repoPath: testRepoPath,
      beforeSeed: async (page) => {
        ids = await page.evaluate(
          async (paths) => {
            const resultIds: string[] = []
            for (const repoPath of paths) {
              const result = await window.api.repos.add({ path: repoPath })
              if ('error' in result) {
                throw new Error(result.error)
              }
              resultIds.push(`${result.repo.id}::${repoPath}`)
            }
            return resultIds
          },
          [testRepoPath, intermediate]
        )
      }
    })
    if (!ids[0] || !ids[1]) {
      throw new Error('Missing owned workspace')
    }
    const markerDirectory = path.join(testRepoPath, 'OWNER_SUBDIRECTORY')
    mkdirSync(markerDirectory)
    writeFileSync(
      path.join(markerDirectory, 'TERMINAL_OWNER.txt'),
      'DESKTOP_TERMINAL_DIRECTORY_OWNER\n'
    )
    execute(
      `mkdir -p ${quotePosixShell(markerDirectory)} && printf 'REMOTE_TERMINAL_DIRECTORY_OWNER\n' > ${quotePosixShell(path.join(markerDirectory, 'TERMINAL_OWNER.txt'))}`
    )
    await dismissTransientAnnouncement(page)
    const localIdentity = getWorktreeHostIdentity({ id: ids[0], hostId: 'local' })
    await page.locator(`[data-worktree-host-identity="${localIdentity}"]:visible`).click()
    await openFileExplorer(page)
    const localFile = page.locator('[data-file-explorer-row]').filter({ hasText: fileName })
    await expect(localFile).toBeVisible()
    await expect(
      page.locator('[data-file-explorer-row]').filter({ hasText: 'OWNER_SUBDIRECTORY' })
    ).toBeVisible()
    await page
      .locator('[data-file-explorer-row]')
      .filter({ hasText: 'OWNER_SUBDIRECTORY' })
      .click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Open in Terminal', exact: true }).click()
    await waitForActivePanePtyId(page, 30_000)
    await focusActiveTerminalInput(page)
    await page.keyboard.insertText('pwd; cat TERMINAL_OWNER.txt')
    await page.keyboard.press('Enter')
    await expect
      .poll(() => getTerminalContent(page), { timeout: 30_000 })
      .toContain('DESKTOP_TERMINAL_DIRECTORY_OWNER')
    console.log('[actual-desktop-terminal]', await getTerminalContent(page))
    await openTerminalWorkspaceRootLink(page, testInfo, intermediate)
    const nativeRoot = page.locator('[data-terminal-link-action-popover]')
    await expect(nativeRoot).toBeVisible()
    await nativeRoot.getByRole('button', { name: /^Switch workspace/ }).click()
    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().activeWorktreeId))
      .toBe(ids[1])
    console.log(
      '[actual-desktop-root-selection]',
      await page.evaluate(() => ({
        id: window.__store?.getState().activeWorktreeId,
        host: window.__store?.getState().activeWorkspaceExecutionHostId
      }))
    )
    const middleIdentity = getWorktreeHostIdentity({ id: ids[1], hostId: 'local' })
    await page.locator(`[data-worktree-host-identity="${middleIdentity}"]:visible`).click()
    await openFileExplorer(page)
    await expect(
      page.locator('[data-file-explorer-row]').filter({ hasText: 'INTERMEDIATE_OWNER.txt' })
    ).toBeVisible()
    const remoteIdentity = getWorktreeHostIdentity({
      id: seeded.worktreeId,
      hostId: toRuntimeExecutionHostId(environmentId)
    })
    await page.locator(`[data-worktree-host-identity="${remoteIdentity}"]:visible`).click()
    await openFileExplorer(page)
    console.log(
      '[actual-renderer-route]',
      await page.evaluate(() => {
        const s = window.__store?.getState()
        return {
          activeWorktreeId: s?.activeWorktreeId,
          activeRepoId: s?.activeRepoId,
          activeWorkspaceExecutionHostId: s?.activeWorkspaceExecutionHostId,
          activeRuntimeEnvironmentId: s?.settings?.activeRuntimeEnvironmentId
        }
      })
    )
    const remoteFile = page.locator('[data-file-explorer-row]').filter({ hasText: fileName })
    await expect(remoteFile).toBeVisible()
    console.log(
      '[actual-remote-source]',
      await serverCall(page, environmentId, 'files.read', {
        worktree: `id:${seeded.worktreeId}`,
        relativePath: fileName
      })
    )
    await page
      .locator('[data-file-explorer-row]')
      .filter({ hasText: 'OWNER_SUBDIRECTORY' })
      .click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Open in Terminal', exact: true }).click()
    await waitForActivePanePtyId(page, 30_000)
    await focusActiveTerminalInput(page)
    await page.keyboard.insertText('pwd; cat TERMINAL_OWNER.txt')
    await page.keyboard.press('Enter')
    await expect
      .poll(() => getTerminalContent(page), { timeout: 30_000 })
      .toContain('REMOTE_TERMINAL_DIRECTORY_OWNER')
    console.log('[actual-managed-terminal]', await getTerminalContent(page))
    execute(
      `mkdir -p ${quotePosixShell(intermediate)} && printf 'REMOTE_LINK_DIRECTORY_OWNER\n' > ${quotePosixShell(path.join(intermediate, 'LINK_DIRECTORY_OWNER.txt'))}`
    )
    console.log(
      '[actual-host-link-directory-marker]',
      execute(`cat ${quotePosixShell(path.join(intermediate, 'LINK_DIRECTORY_OWNER.txt'))}`)
    )
    const foreignTarget = await openTerminalWorkspaceRootLink(page, testInfo, intermediate)
    const popover = page.locator('[data-terminal-link-action-popover]')
    await expect(popover).toBeVisible()
    await expect(popover.locator('[data-terminal-link-destination]')).toHaveText(intermediate)
    await expect
      .poll(() => popover.evaluate((element) => getComputedStyle(element).opacity))
      .toBe('1')
    console.log('[actual-managed-foreign-root-menu]', await popover.innerText())
    await page.screenshot({ path: testInfo.outputPath('managed-terminal-root-link-menu.png') })
    const foreignSwitch = popover.getByRole('button', { name: /^Switch workspace/ })
    if (await foreignSwitch.count()) {
      await foreignSwitch.click()
      await expect
        .poll(() => page.evaluate(() => window.__store?.getState().activeWorktreeId))
        .toBe(ids[1])
    }
    const route = await page.evaluate(() => {
      const s = window.__store?.getState()
      return {
        activeWorktreeId: s?.activeWorktreeId,
        activeRepoId: s?.activeRepoId,
        activeWorkspaceExecutionHostId: s?.activeWorkspaceExecutionHostId
      }
    })
    console.log('[actual-selection-after-managed-link]', route)
    await page.screenshot({ path: testInfo.outputPath('managed-terminal-root-link-selection.png') })
    expect(route.activeWorkspaceExecutionHostId).toBe(toRuntimeExecutionHostId(environmentId))
    expect(route.activeWorktreeId).toBe(seeded.worktreeId)
    await expect(foreignSwitch).toHaveCount(0)
    await popover.getByRole('button', { name: /^Open file/ }).click()
    console.log(
      '[managed-directory-click-host-read]',
      await serverCall(page, environmentId, 'files.read', {
        worktree: `id:${seeded.worktreeId}`,
        relativePath: 'intermediate-command-repo/LINK_DIRECTORY_OWNER.txt'
      })
    )
    await page.mouse.move(foreignTarget.x, foreignTarget.y)
    const primaryModifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.down(primaryModifier)
    try {
      await page.mouse.click(foreignTarget.x, foreignTarget.y)
    } finally {
      await page.keyboard.up(primaryModifier)
    }
    await serverCall(page, environmentId, 'files.read', {
      worktree: `id:${seeded.worktreeId}`,
      relativePath: 'intermediate-command-repo/LINK_DIRECTORY_OWNER.txt'
    })
    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().activeWorkspaceExecutionHostId))
      .toBe(toRuntimeExecutionHostId(environmentId))
    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().activeWorktreeId))
      .toBe(seeded.worktreeId)
    console.log(
      '[actual-managed-direct-link-selection]',
      await page.evaluate(() => ({
        id: window.__store?.getState().activeWorktreeId,
        host: window.__store?.getState().activeWorkspaceExecutionHostId
      }))
    )
    await openTerminalWorkspaceRootLink(page, testInfo, testRepoPath)
    const ownRoot = page.locator('[data-terminal-link-action-popover]')
    await expect(ownRoot).toBeVisible()
    await ownRoot.getByRole('button', { name: /^Switch workspace/ }).click()
    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().activeWorkspaceExecutionHostId))
      .toBe(toRuntimeExecutionHostId(environmentId))
    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().activeWorktreeId))
      .toBe(seeded.worktreeId)
    console.log(
      '[actual-managed-same-root-selection]',
      await page.evaluate(() => ({
        id: window.__store?.getState().activeWorktreeId,
        host: window.__store?.getState().activeWorkspaceExecutionHostId
      }))
    )
  })
})

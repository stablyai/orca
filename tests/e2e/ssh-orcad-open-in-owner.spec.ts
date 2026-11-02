import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { serverCall } from './helpers/orcad-convert-flow'
import {
  launchConvertedProfile,
  skipUnlessManagedDockerHost,
  withManagedHost
} from './helpers/orcad-managed-workspace'
import { dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'
import { toRuntimeExecutionHostId } from '../../src/shared/execution-host'
import { folderWorkspaceKey } from '../../src/shared/workspace-scope'
import { quotePosixShell } from '../../src/shared/wsl-login-shell-command'

skipUnlessManagedDockerHost()
test.skip(process.platform === 'win32', 'Needs a POSIX recorder')

for (const surface of [
  'source-control',
  'explorer-toolbar',
  'workspace-menu',
  'folder-menu'
] as const) {
  test(`a managed ${surface} target cannot launch a local editor for a same-path desktop file`, async (// oxlint-disable-next-line no-empty-pattern -- This exercise owns its app launch.
  {}, testInfo) => {
    test.setTimeout(4 * 60_000)
    const owned = mkdtempSync(path.join(os.tmpdir(), 'orca-open-in-owner-'))
    const repoPath = path.join(owned, 'repo')
    const filePath = path.join(repoPath, 'README.md')
    const folderPath = path.join(owned, 'folder')
    const recorder = path.join(owned, 'record-editor')
    const receiptPath = path.join(owned, 'editor-receipt')
    const localMarker = 'LOCAL_ONLY_EDITOR_COLLISION'
    const remoteMarker = 'REMOTE_ONLY_EDITOR_OWNER'
    mkdirSync(repoPath)
    writeFileSync(filePath, `${localMarker}\n`)
    mkdirSync(folderPath)
    writeFileSync(path.join(folderPath, 'README.md'), `${localMarker}\n`)
    // This recorder writes argv/content and exits; it never opens or focuses a window.
    writeFileSync(
      recorder,
      `#!/bin/sh\nprintf 'DESKTOP_PID=%s\\nARG=%s\\n' "$$" "$1" > ${quotePosixShell(receiptPath)}\nif [ -d "$1" ]; then cat "$1/README.md"; else cat "$1"; fi >> ${quotePosixShell(receiptPath)}\n`
    )
    chmodSync(recorder, 0o755)
    const receipt = (): string => (existsSync(receiptPath) ? readFileSync(receiptPath, 'utf8') : '')
    await withManagedHost(testInfo, async (fixture) => {
      const { host } = fixture
      if (!host.exec) {
        throw new Error('Missing owned Docker controls')
      }
      const execute = host.exec
      execute(
        `mkdir -p ${quotePosixShell(owned)} && git clone --quiet ${quotePosixShell(host.remoteRepoPath)} ${quotePosixShell(repoPath)} && printf '%s\\n' ${quotePosixShell(`# ${remoteMarker}`)} > ${quotePosixShell(filePath)} && mkdir -p ${quotePosixShell(folderPath)} && printf '%s\\n' ${quotePosixShell(`# ${remoteMarker}`)} > ${quotePosixShell(path.join(folderPath, 'README.md'))}`
      )
      const { page, seeded, environmentId } = await launchConvertedProfile(fixture, {
        repoPath,
        folderPath,
        beforeSeed: async (page) => {
          expect(
            await page.evaluate(
              async ({ filePath, recorder }) =>
                window.api.shell.openInExternalEditor({
                  path: filePath,
                  command: recorder,
                  ownerHostId: 'local'
                }),
              { filePath, recorder }
            )
          ).toEqual({ ok: true })
          await expect.poll(receipt).toContain(localMarker)
          console.log('[local-recorder-control]', receipt())
          rmSync(receiptPath)
        }
      })
      const readConvertedFolderId = () =>
        page.evaluate(
          (folderPath) =>
            window.__store
              ?.getState()
              .folderWorkspaces.find((folder) => folder.folderPath === folderPath)?.id,
          folderPath
        )
      if (surface === 'folder-menu') {
        await expect.poll(readConvertedFolderId, { timeout: 30_000 }).toBeTruthy()
      }
      const convertedFolderId = surface === 'folder-menu' ? await readConvertedFolderId() : null
      if (surface === 'folder-menu' && !convertedFolderId) {
        throw new Error('Missing converted folder')
      }
      const workspaceId = convertedFolderId
        ? folderWorkspaceKey(convertedFolderId)
        : seeded.worktreeId
      const content = await serverCall(page, environmentId, 'files.read', {
        worktree: `id:${workspaceId}`,
        relativePath: 'README.md'
      })
      console.log('[remote-owned-file]', content)
      expect(content).toContain(remoteMarker)
      await page.evaluate(
        async ({ id, hostId, recorder }) => {
          const state = window.__store?.getState()
          if (!state) {
            throw new Error('Missing renderer store')
          }
          state.setActiveWorktree(id, hostId)
          await state.updateSettings({
            openInApplications: [{ id: 'recorder', label: 'Recording editor', command: recorder }]
          })
          state.setRightSidebarTab('explorer')
          state.setRightSidebarOpen(true)
        },
        { id: workspaceId, hostId: toRuntimeExecutionHostId(environmentId), recorder }
      )
      expect(
        await page.evaluate(() => window.__store?.getState().settings?.activeRuntimeEnvironmentId)
      ).toBeNull()
      await dismissTransientAnnouncement(page)
      if (surface !== 'folder-menu') {
        await expect(page.locator('.rich-markdown-editor')).toContainText(remoteMarker, {
          timeout: 30_000
        })
      }
      if (surface === 'source-control') {
        await page.getByRole('button', { name: /Source Control/ }).click()
        await expect(page.getByRole('textbox', { name: 'Commit message' })).toBeVisible()
        const entry = page
          .locator('[data-testid="source-control-entry"]')
          .filter({ hasText: 'README.md' })
        await expect(entry).toBeVisible({ timeout: 15_000 })
        await entry.click({ button: 'right' })
        await expect(
          page.getByRole('menuitem', {
            name: /Reveal in Finder|Reveal in File Explorer|Open Containing Folder/
          })
        ).toBeDisabled()
        await page.getByRole('menuitem', { name: 'Open in', exact: true }).hover()
      } else if (surface === 'explorer-toolbar') {
        await page.evaluate(() => window.__store?.getState().showRightSidebarFiles())
        await page.getByRole('button', { name: 'More Explorer Actions', exact: true }).click()
      } else {
        await page.evaluate(() => window.__store?.getState().setActiveWorktree(null))
        await page
          .locator(`[data-worktree-id="${workspaceId}"]:visible`)
          .first()
          .click({ button: 'right' })
        await page.getByRole('menuitem', { name: 'Open in', exact: true }).hover()
      }
      const editor = page.getByRole('menuitem', { name: /Recording editor/ })
      await expect(editor).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath(`${surface}-editor-owner-observed.png`) })
      if (await editor.isEnabled()) {
        await editor.click()
        await expect.poll(receipt).toContain(localMarker)
      }
      console.log('[remote-menu-local-editor-receipt]', receipt())
      expect(receipt(), 'A remote menu must not launch an editor for the desktop collision').toBe(
        ''
      )
      await expect(editor).toBeDisabled()
      await page.screenshot({
        path: testInfo.outputPath(`${surface}-editor-owner-corrected.png`)
      })
    }).finally(() => rmSync(owned, { recursive: true, force: true }))
  })
}

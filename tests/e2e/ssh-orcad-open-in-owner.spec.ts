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
import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { startOrcadConvertHost } from './helpers/orcad-convert-host'
import { seedRelayEraProfile } from './helpers/orcad-upgrade-profile'
import { convertAndRetain, serverCall } from './helpers/orcad-convert-flow'
import { waitForSessionReady } from './helpers/store'
import { dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'
import { shellQuote } from './helpers/docker-ssh-relay-target'
import { toRuntimeExecutionHostId } from '../../src/shared/execution-host'
import { folderWorkspaceKey } from '../../src/shared/workspace-scope'

const TEMPLATE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE

test.skip(
  !TEMPLATE || process.env.ORCA_E2E_SSH_DOCKER !== '1' || process.platform === 'win32',
  'Needs a POSIX recorder, Docker, and a server template'
)

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
      `#!/bin/sh\nprintf 'DESKTOP_PID=%s\\nARG=%s\\n' "$$" "$1" > ${shellQuote(receiptPath)}\nif [ -d "$1" ]; then cat "$1/README.md"; else cat "$1"; fi >> ${shellQuote(receiptPath)}\n`
    )
    chmodSync(recorder, 0o755)
    const receipt = (): string => (existsSync(receiptPath) ? readFileSync(receiptPath, 'utf8') : '')
    const host = startOrcadConvertHost('docker', testInfo)
    const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE! })
    let app: ElectronApplication | null = null
    try {
      if (!host.exec) {
        throw new Error('Missing owned Docker controls')
      }
      const execute = host.exec
      execute(
        `mkdir -p ${shellQuote(owned)} && git clone --quiet ${shellQuote(host.remoteRepoPath)} ${shellQuote(repoPath)} && printf '%s\\n' ${shellQuote(`# ${remoteMarker}`)} > ${shellQuote(filePath)} && mkdir -p ${shellQuote(folderPath)} && printf '%s\\n' ${shellQuote(`# ${remoteMarker}`)} > ${shellQuote(path.join(folderPath, 'README.md'))}`
      )
      const first = await session.launch()
      app = first.app
      await waitForSessionReady(first.page)
      expect(
        await first.page.evaluate(
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
      await session.close(app)
      app = null
      const seeded = seedRelayEraProfile(session.userDataDir, host.input, {
        repoPath,
        folderPath
      })
      const launched = await session.launch()
      app = launched.app
      const page = launched.page
      await waitForSessionReady(page)
      await convertAndRetain(page, session.userDataDir, seeded)
      const environment = (await page.evaluate(() => window.api.runtimeEnvironments.list())).find(
        (entry) => entry.orcadDeployment?.sshTargetId === seeded.targetId
      )
      if (!environment) {
        throw new Error('Missing managed environment')
      }
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
      const content = await serverCall(page, environment.id, 'files.read', {
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
        { id: workspaceId, hostId: toRuntimeExecutionHostId(environment.id), recorder }
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
    } finally {
      try {
        if (app) {
          await session.close(app)
        }
        await session.dispose()
      } finally {
        host.cleanup()
        rmSync(owned, { recursive: true, force: true })
      }
    }
  })
}

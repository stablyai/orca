import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { getOwnedTempStagingRoot } from '../../src/main/window/owned-temp-staging-root'
import { FILE_UPLOAD_EXISTING_PARENT_RUNTIME_CAPABILITY } from '../../src/shared/protocol-version'
import { quotePosixShell } from '../../src/shared/wsl-login-shell-command'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { waitForSessionReady } from './helpers/store'
import { openFileExplorer } from './helpers/file-explorer'
import { installImagePasteClipboard } from './helpers/paired-image-paste-probes'
import {
  cleanupDockerSshHostTarget,
  execDockerSshHostTargetCommand,
  startDockerSshHostTarget
} from './helpers/docker-ssh-host-target'

test('pastes clipboard pixels into a Linux folder through managed SSH', async (// oxlint-disable-next-line no-empty-pattern -- This test owns its isolated desktop and Docker SSH host.
{}, testInfo) => {
  const template = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
  test.skip(
    process.env.ORCA_E2E_SSH_DOCKER !== '1' || !template,
    'Requires Docker SSH and a Linux orcad template built from this checkout.'
  )
  if (!template) {
    throw new Error('Missing Linux orcad template')
  }
  test.setTimeout(10 * 60_000)
  const target = startDockerSshHostTarget(testInfo)
  const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: template })
  const root = '/tmp/image-paste-workspace'
  const folderName = 'clipboard image á'
  const destination = `${root}/${folderName}`
  let app: ElectronApplication | undefined
  try {
    execDockerSshHostTargetCommand(target, `mkdir -p ${quotePosixShell(destination)}`)
    const launched = await session.launch()
    app = launched.app
    const { page } = launched
    await waitForSessionReady(page)
    const environmentId = await page.evaluate(
      async (input) => {
        const { target } = await window.api.ssh.addTarget({ target: input })
        const state = await window.api.ssh.connect({ targetId: target.id })
        if (state?.managedServer?.kind !== 'managed') {
          throw new Error(`Expected managed SSH server: ${JSON.stringify(state?.managedServer)}`)
        }
        return state.managedServer.environmentId
      },
      {
        label: 'Image paste Linux SSH',
        host: target.host,
        port: target.port,
        username: 'root',
        identityFile: target.identityFile,
        identitiesOnly: true,
        relayGracePeriodSeconds: 1
      }
    )
    const status = await page.evaluate(
      async ({ environmentId, root }) => {
        const added = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'repo.add',
          params: { path: root, kind: 'folder' }
        })
        if (!added.ok) {
          throw new Error(added.error.message)
        }
        const response = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'status.get'
        })
        if (!response.ok) {
          throw new Error(response.error.message)
        }
        return response.result
      },
      { environmentId, root }
    )
    expect(status).toMatchObject({
      capabilities: expect.arrayContaining([FILE_UPLOAD_EXISTING_PARENT_RUNTIME_CAPABILITY])
    })
    await page.waitForFunction(
      (root) =>
        window.__store
          ?.getState()
          .allWorktrees()
          .some((entry) => entry.path === root),
      root,
      { timeout: 60_000 }
    )
    await page.evaluate(
      ({ root, environmentId }) => {
        const state = window.__store!.getState()
        const worktree = state.allWorktrees().find((entry) => entry.path === root)
        if (!worktree) {
          throw new Error('Linux folder workspace unavailable')
        }
        state.setActiveWorktree(worktree.id, `runtime:${environmentId}`)
      },
      { root, environmentId }
    )
    await openFileExplorer(page)
    const row = (name: string) =>
      page
        .locator('[data-file-explorer-row]')
        .filter({ has: page.getByText(name, { exact: true }) })
    const folder = row(folderName)
    await expect(folder).toBeVisible({ timeout: 30_000 })
    const clipboard = await installImagePasteClipboard(app)
    try {
      const expected = await clipboard.evaluate((probe) => probe.png)
      await folder.click()
      await folder.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v')
      await expect(row('pasted-image.png')).toHaveAttribute('data-selected', 'true', {
        timeout: 30_000
      })
      await row('pasted-image.png').click({ button: 'right' })
      await page.getByRole('menuitem', { name: /Paste Image/ }).click()
      await expect(row('pasted-image copy.png')).toHaveAttribute('data-selected', 'true', {
        timeout: 30_000
      })
      // Read from the Linux host; these paths do not exist on the Windows client.
      for (const name of ['pasted-image.png', 'pasted-image copy.png']) {
        expect(
          execDockerSshHostTargetCommand(
            target,
            `base64 -w0 ${quotePosixShell(`${destination}/${name}`)}`
          )
        ).toBe(expected)
      }
      expect(
        execDockerSshHostTargetCommand(
          target,
          `find ${quotePosixShell(destination)} -mindepth 1 -maxdepth 1 -printf '%f\n' | sort`
        )
      ).toBe('pasted-image copy.png\npasted-image.png')
      const staging = getOwnedTempStagingRoot(session.userDataDir, 'clipboard-image-imports')
      await expect.poll(() => readdir(staging).then((entries) => entries.length)).toBe(2)
      await page.keyboard.press('Escape')
      await page.screenshot({ path: testInfo.outputPath('ssh-linux-image-paste.png') })
      await page.reload()
      await expect.poll(() => readdir(staging)).toEqual([])
      await testInfo.attach('ssh-linux-image-paste.json', {
        body: JSON.stringify(
          {
            transport: 'managed SSH to isolated Linux Docker host',
            clipboard: 'controlled client reads',
            destination,
            sha256: createHash('sha256').update(Buffer.from(expected, 'base64')).digest('hex'),
            copies: 2,
            clientStagingEmpty: true,
            hostUploadTempsEmpty: true
          },
          null,
          2
        ),
        contentType: 'application/json'
      })
    } finally {
      await clipboard.evaluate((probe) => probe.restore())
      await clipboard.dispose()
    }
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
    cleanupDockerSshHostTarget(target)
  }
})

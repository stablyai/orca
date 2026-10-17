import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import { installImagePasteClipboard } from './helpers/paired-image-paste-probes'
import { getOwnedTempStagingRoot } from '../../src/main/window/owned-temp-staging-root'

test.use({ seedTestRepo: false })

test('reveals paste in a collapsed folder and undoes/redoes exact PNG bytes', async ({
  orcaPage: page,
  electronApp: app,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-image-paste-history-'))
  registerPostElectronShutdownCleanup(() => rm(root, { recursive: true, force: true }))
  const destination = path.join(root, 'Cole aqui')
  await mkdir(destination)
  const existing = Buffer.from('existing file must survive')
  await writeFile(path.join(destination, 'pasted-image.png'), existing)
  const workspaceId = await page.evaluate(async (root) => {
    const result = await window.api.repos.add({ path: root, kind: 'folder' })
    if ('error' in result) {
      throw new Error(result.error)
    }
    await window.__store!.getState().fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
    await window.__store!.getState().fetchWorktrees(result.repo.id)
    return result.repo.id
  }, root)
  await page.waitForFunction(
    (id) => window.__store?.getState().worktreesByRepo[id]?.length,
    workspaceId
  )
  await page.evaluate((id) => {
    const state = window.__store!.getState()
    state.setActiveWorktree(state.worktreesByRepo[id][0].id)
  }, workspaceId)
  await openFileExplorer(page)
  const row = (name: string) =>
    page.locator('[data-file-explorer-row]').filter({ has: page.getByText(name, { exact: true }) })
  const folder = row('Cole aqui')
  const created = row('pasted-image copy.png')
  const chord = process.platform === 'darwin' ? 'Meta' : 'Control'
  const clipboard = await installImagePasteClipboard(app)
  try {
    const expected = Buffer.from(await clipboard.evaluate((probe) => probe.png), 'base64')
    await folder.click()
    await expect(row('pasted-image.png')).toBeVisible()
    // Keep the folder selected while collapsing it, reproducing the manual report.
    await folder.press('ArrowLeft')
    await expect(row('pasted-image.png')).toHaveCount(0)
    await expect(folder).toHaveAttribute('data-selected', 'true')
    await folder.press(`${chord}+v`)
    await expect(created).toBeVisible()
    await expect(created).toHaveAttribute('data-selected', 'true')
    expect(await readFile(path.join(destination, 'pasted-image copy.png'))).toEqual(expected)
    await page.screenshot({ path: testInfo.outputPath('collapsed-folder-paste-revealed.png') })

    await page.keyboard.press(`${chord}+z`)
    await expect(created).toHaveCount(0)
    await expect.poll(() => readdir(destination)).toEqual(['pasted-image.png'])
    expect(await readFile(path.join(destination, 'pasted-image.png'))).toEqual(existing)
    await expect(folder).toHaveAttribute('data-selected', 'true')

    await clipboard.evaluate((probe) => probe.restore())
    await app.evaluate(({ clipboard }) => {
      // Redo must use the owned snapshot even when the current clipboard has no image.
      clipboard.readImage = () => {
        throw new Error('Redo read the clipboard')
      }
    })
    await page.keyboard.press(`${chord}+Shift+z`)
    await expect(created).toHaveAttribute('data-selected', 'true')
    expect(await readFile(path.join(destination, 'pasted-image copy.png'))).toEqual(expected)
    expect(await readFile(path.join(destination, 'pasted-image.png'))).toEqual(existing)

    const profile = await app.evaluate(({ app }) => app.getPath('userData'))
    const staging = getOwnedTempStagingRoot(profile, 'clipboard-image-imports')
    await expect.poll(() => readdir(staging).then((entries) => entries.length)).toBe(1)
    // Renderer navigation discards its undo stack and releases owned snapshots.
    await page.reload()
    await expect.poll(() => readdir(staging)).toEqual([])
  } finally {
    await clipboard.evaluate((probe) => probe.restore())
    await clipboard.dispose()
  }
})

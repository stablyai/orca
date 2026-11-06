import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'

// 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

test('orca-media URLs load only as app elements: no fetch, and no other session can read them', async ({
  orcaPage,
  electronApp,
  seededRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const filePath = path.join(seededRepoPath, 'isolation-probe.png')
  writeFileSync(filePath, PNG)
  registerPostElectronShutdownCleanup(async () => rmSync(filePath, { force: true }))
  await orcaPage.evaluate((filePath) => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      throw new Error('Missing fixture worktree')
    }
    state.openFile({
      filePath,
      relativePath: 'isolation-probe.png',
      worktreeId: state.activeWorktreeId,
      language: 'plaintext',
      mode: 'edit'
    })
  }, filePath)
  const image = orcaPage.locator('img[src^="orca-media://"]').first()
  await expect(image).toBeVisible()
  const url = await image.getAttribute('src')
  expect(url).toBeTruthy()

  // The app's own page shows the image but cannot read its bytes: the scheme has no fetch privilege.
  const pageFetch = await orcaPage.evaluate(async (url) => {
    try {
      await fetch(url)
      return 'read'
    } catch {
      return 'refused'
    }
  }, url ?? '')
  expect(pageFetch).toBe('refused')

  const sessions = await electronApp.evaluate(async ({ session }, url) => {
    const probe = async (target: Electron.Session): Promise<string> =>
      target.fetch(url).then(
        (response) => String(response.status),
        () => 'refused'
      )
    return {
      app: await probe(session.defaultSession),
      browserPartition: await probe(session.fromPartition('persist:orca-media-isolation-probe'))
    }
  }, url ?? '')
  // Main's own session serves the grant; a browser-pane-style partition has no handler at all.
  expect(sessions).toEqual({ app: '200', browserPartition: 'refused' })
})

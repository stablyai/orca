import { readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'

test.use({ seedTestRepo: false })
test.skip(process.platform === 'win32', 'Restrictive-umask fsync regression is POSIX-only')

test('recreates a fresh profile index on disk with a restrictive umask @posix-profile-index-golden', async ({
  electronApp,
  orcaPage
}) => {
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const indexPath = path.join(userDataDir, 'orca-profile-index.json')
  // Clear owner-write in the umask to reproduce r+ fsync failing with EACCES.
  const originalUmask = await electronApp.evaluate(() => process.umask(0o200))

  try {
    rmSync(indexPath, { force: true })
    rmSync(`${indexPath}.bak`, { force: true })
    // Listing a missing index drives the real create/fsync/rename path.
    const listed = await orcaPage.evaluate(async () => {
      const result = await window.api.orcaProfiles.list()
      window.__store!.getState().openSettingsPage()
      return result
    })
    expect(listed.profiles.length).toBeGreaterThan(0)

    // Require persisted complete data; an in-memory list cannot prove fsync survived.
    const persisted = JSON.parse(readFileSync(indexPath, 'utf-8'))
    expect(persisted.activeProfileId).toBe(listed.activeProfileId)
    expect(persisted.profiles.map((profile: { id: string }) => profile.id)).toEqual(
      listed.profiles.map((profile) => profile.id)
    )
    // Require owner-write cleared to prove this is the restrictive-umask write, not startup’s index.
    expect(statSync(indexPath).mode & 0o200).toBe(0)
  } finally {
    await electronApp.evaluate((_electron, umask) => process.umask(umask), originalUmask)
  }

  await expect(orcaPage.getByPlaceholder('Search settings')).toBeVisible()
})

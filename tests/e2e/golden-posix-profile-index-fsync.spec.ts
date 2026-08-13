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
  // Why: the index tmp file is written with 0o666 & ~umask, so a umask that clears
  // owner-write is what made the pre-fix fsync open(path, 'r+') fail with EACCES.
  const originalUmask = await electronApp.evaluate(() => process.umask(0o200))

  try {
    rmSync(indexPath, { force: true })
    rmSync(`${indexPath}.bak`, { force: true })
    // Why: orcaProfiles:list reads the index from disk on every call and rebuilds
    // it when missing, so this drives the real create + fsync + rename path.
    const listed = await orcaPage.evaluate(async () => {
      const result = await window.api.orcaProfiles.list()
      window.__store!.getState().openSettingsPage()
      return result
    })
    expect(listed.profiles.length).toBeGreaterThan(0)

    // The rebuilt index must be on disk and complete — a cached in-memory list is
    // not proof that the restrictive-umask write survived fsync.
    const persisted = JSON.parse(readFileSync(indexPath, 'utf-8'))
    expect(persisted.activeProfileId).toBe(listed.activeProfileId)
    expect(persisted.profiles.map((profile: { id: string }) => profile.id)).toEqual(
      listed.profiles.map((profile) => profile.id)
    )
    // Owner-write cleared proves the file was created under the restrictive umask
    // rather than left over from startup's normal-umask write.
    expect(statSync(indexPath).mode & 0o200).toBe(0)
  } finally {
    await electronApp.evaluate((_electron, umask) => process.umask(umask), originalUmask)
  }

  await expect(orcaPage.getByPlaceholder('Search settings')).toBeVisible()
})

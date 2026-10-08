import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { orcaCliResult } from './helpers/compiled-orca-cli'
import { waitForSessionReady } from './helpers/store'

function writePetBundle(): string {
  const bundleDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-pet-bundle-'))
  // Why gremlin.webp: a real raster sheet, so the import's frame check decodes it as users' sheets are.
  copyFileSync(
    path.join(process.cwd(), 'resources', 'gremlin.webp'),
    path.join(bundleDir, 'sheet.webp')
  )
  writeFileSync(
    path.join(bundleDir, 'pet.json'),
    JSON.stringify({
      id: 'cli-pet',
      displayName: 'Leonardo da Vinci',
      spritesheetPath: 'sheet.webp',
      frame: { width: 252, height: 320 },
      defaultAnimation: 'idle',
      animations: { idle: { row: 0, frames: 1 } }
    })
  )
  return bundleDir
}

test('orca pet commands update the pet menu without a reload', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(async () => {
    await window.__store?.getState().updateSettings({ uiLanguage: 'en', experimentalPet: true })
  })
  const petMenu = orcaPage.getByRole('button', { name: 'Pet menu' })
  await expect(petMenu).toHaveText('Claudino')

  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const bundleDir = writePetBundle()
  try {
    await orcaCliResult(userDataDir, ['pet', 'import', '--path', bundleDir])
  } finally {
    // Why delete before asserting: the pet must render from Orca's own copy, not the source folder.
    rmSync(bundleDir, { recursive: true, force: true })
  }
  await expect(petMenu).toHaveText('Leonardo da Vinci')

  await orcaCliResult(userDataDir, [
    'pet',
    'rename',
    '--pet',
    'Leonardo da Vinci',
    '--name',
    'Da Vinci'
  ])
  await expect(petMenu).toHaveText('Da Vinci')

  await orcaCliResult(userDataDir, ['pet', 'select', '--pet', 'gremlin-the-trickster'])
  await expect(petMenu).toHaveText('Gremlin')

  await orcaCliResult(userDataDir, ['pet', 'select', '--pet', 'Da Vinci'])
  await expect(petMenu).toHaveText('Da Vinci')

  await orcaCliResult(userDataDir, ['pet', 'rm', '--pet', 'Da Vinci'])
  await expect(petMenu).toHaveText('Claudino')
})

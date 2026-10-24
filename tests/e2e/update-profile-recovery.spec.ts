import type { ElectronApplication } from '@stablyai/playwright-test'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { waitForSessionReady } from './helpers/store'
import { createUpdateProfileSnapshot } from '../../src/main/update-profile-snapshot'
import { restoreUpdateProfileSnapshot } from '../../src/main/update-profile-restore'
import { cleanupE2EDaemons } from './helpers/electron-process-shutdown'

// oxlint-disable-next-line no-empty-pattern -- Owns the isolated profile across two launches.
test('a recovered profile loads saved settings without reinitialization', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const session = createRestartSession(testInfo, { ORCA_BACKGROUND_LAUNCH: '1' })
  let active: ElectronApplication | undefined
  const original = `${session.userDataDir}-before-recovery`
  try {
    const first = await session.launch()
    active = first.app
    await waitForSessionReady(first.page)
    await first.page.evaluate(async () => {
      await window
        .__store!.getState()
        .updateSettingsOrThrow({ theme: 'dark', terminalFontSize: 19 })
    })
    await expect(first.page.locator('html')).toHaveClass(/dark/)
    await first.page.screenshot({ path: testInfo.outputPath('before-recovery.png') })
    await writeFile(join(session.userDataDir, 'workflow.md'), '# Existing workflow\n')
    await writeFile(join(session.userDataDir, 'history.json'), '["existing task"]')
    await session.close(active)
    active = undefined
    await cleanupE2EDaemons(session.userDataDir)
    const backup = await createUpdateProfileSnapshot(
      session.userDataDir,
      'before-update',
      testInfo.outputPath('backups')
    )
    await rename(session.userDataDir, original)
    await restoreUpdateProfileSnapshot(backup, session.userDataDir)
    const second = await session.launch()
    active = second.app
    await waitForSessionReady(second.page)
    expect(
      await second.page.evaluate(() => ({
        theme: window.__store!.getState().settings?.theme,
        terminalFontSize: window.__store!.getState().settings?.terminalFontSize
      }))
    ).toEqual({ theme: 'dark', terminalFontSize: 19 })
    await expect(second.page.locator('html')).toHaveClass(/dark/)
    expect(await readFile(join(session.userDataDir, 'workflow.md'), 'utf8')).toBe(
      '# Existing workflow\n'
    )
    expect(await readFile(join(session.userDataDir, 'history.json'), 'utf8')).toBe(
      '["existing task"]'
    )
    await second.page.screenshot({ path: testInfo.outputPath('after-recovery.png') })
    expect(
      await active.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible())
      )
    ).toBe(true)
  } finally {
    try {
      await session.dispose(active)
    } finally {
      await rm(original, { recursive: true, force: true })
    }
  }
})

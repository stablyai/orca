import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { addAndActivateRepo } from './helpers/isolated-repo-activation'
import { createIsolatedLargeDiffRepo } from './large-diff-repro-fixtures'

type WriteArgs = { filePath: string; content: string }
type WriteHandler = (event: unknown, args: WriteArgs) => unknown
type SaveBarrierScope = typeof globalThis & {
  __diffSaveBarrier?: { captured: boolean; release: () => void; restore: () => void }
}

test.use({ seedTestRepo: false })
test('combined diff keeps later typing visible and dirty when an earlier save finishes', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const fixture = createIsolatedLargeDiffRepo('export const message = "original"\n')
  registerPostElectronShutdownCleanup(async () =>
    rmSync(fixture.repoPath, { recursive: true, force: true })
  )
  const modified = 'export const message = "modified"'
  writeFileSync(fixture.absolutePath, `${modified}\n`)
  await waitForSessionReady(orcaPage)
  await addAndActivateRepo(orcaPage, fixture.repoPath)
  await orcaPage.getByRole('button', { name: /^Source Control/ }).click()
  await orcaPage.getByRole('button', { name: 'View all', exact: true }).first().click()
  const line = orcaPage
    .locator('diffs-container [data-content] [data-line]')
    .filter({ hasText: modified })
  await line.click({ timeout: 20_000 })
  await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End')
  await orcaPage.keyboard.type(' // first save', { delay: 20 })
  await expect(line).toHaveText(`${modified} // first save`)

  await electronApp.evaluate(({ ipcMain }, targetPath) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, WriteHandler> })
      ._invokeHandlers
    const original = handlers.get('fs:writeFile')
    if (!original) {
      throw new Error('Missing file write handler')
    }
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const barrier = {
      captured: false,
      release,
      restore: () => {
        handlers.set('fs:writeFile', original)
        release()
      }
    }
    ;(globalThis as SaveBarrierScope).__diffSaveBarrier = barrier
    handlers.set('fs:writeFile', async (event, args) => {
      if (args.filePath === targetPath && !barrier.captured) {
        barrier.captured = true
        await pending
      }
      return original(event, args)
    })
  }, fixture.absolutePath)
  try {
    await orcaPage.keyboard.press('ControlOrMeta+s')
    await expect
      .poll(() =>
        electronApp.evaluate(() => (globalThis as SaveBarrierScope).__diffSaveBarrier?.captured)
      )
      .toBe(true)
    await orcaPage.keyboard.type(' plus newer typing', { delay: 20 })
    await expect(line).toHaveText(`${modified} // first save plus newer typing`)
    await electronApp.evaluate(() => (globalThis as SaveBarrierScope).__diffSaveBarrier!.release())
    await expect
      .poll(() => readFileSync(fixture.absolutePath, 'utf8'))
      .toBe(`${modified} // first save\n`)
    // Wait past parser feedback and filesystem revalidation to catch late draft replacement.
    await orcaPage.waitForTimeout(700)
    await expect(line).toHaveText(`${modified} // first save plus newer typing`)
    await orcaPage.keyboard.press('ControlOrMeta+s')
    await expect
      .poll(() => readFileSync(fixture.absolutePath, 'utf8'))
      .toBe(`${modified} // first save plus newer typing\n`)
    await expect(line).toHaveText(`${modified} // first save plus newer typing`)
    await orcaPage.screenshot({ path: testInfo.outputPath('retained-newer-draft.png') })
  } finally {
    await electronApp.evaluate(() => {
      ;(globalThis as SaveBarrierScope).__diffSaveBarrier?.restore()
      delete (globalThis as SaveBarrierScope).__diffSaveBarrier
    })
  }
})

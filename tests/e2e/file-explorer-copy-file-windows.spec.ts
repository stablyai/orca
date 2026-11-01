import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runProcess } from '@orca/process-host'
import { windowsPowerShellPath } from '@orca/process-host/windows-system-binary'
import { test, expect } from './helpers/orca-app'

test.use({ seedTestRepo: false })

// Include quotes, PowerShell syntax and Unicode to detect paths accidentally executed as script.
const FILE_NAME = "o'brien $(exit 7) ü.txt"

// Prove a real CF_HDROP with Explorer’s paste verb; FileNameW alone reads back but pastes nothing.
async function shellPasteInto(folder: string): Promise<void> {
  const result = await runProcess({
    program: windowsPowerShellPath(),
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(New-Object -ComObject Shell.Application).NameSpace($env:PASTE_TARGET).Self.InvokeVerb("paste")'
    ],
    env: { ...process.env, PASTE_TARGET: folder },
    timeoutMs: 30_000
  })
  expect(result.code, result.stderr).toBe(0)
}

test.describe('file explorer Copy on Windows', () => {
  test.skip(process.platform !== 'win32', 'Exercises the Windows CF_HDROP clipboard path')

  test('puts a file Explorer can paste on the clipboard', async ({
    orcaPage: page,
    electronApp,
    registerPostElectronShutdownCleanup
  }) => {
    // Native realpath: runners hand out an 8.3 temp path, but the app copies the long one.
    const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), 'orca-copy-file-')))
    registerPostElectronShutdownCleanup(() => rm(folder, { recursive: true, force: true }))
    const source = path.join(folder, 'workspace')
    const pasteTarget = path.join(folder, 'paste-target')
    await mkdir(source)
    await mkdir(pasteTarget)
    await writeFile(path.join(source, FILE_NAME), 'copied through the clipboard\n')

    await page.evaluate(async (source) => {
      await window.__store!.getState().addRepoPath(source, 'folder')
    }, source)
    await page.getByRole('option').filter({ hasText: 'workspace' }).click()
    await page
      .locator('[data-orca-explorer-shell]')
      .getByRole('button', { name: FILE_NAME, exact: true })
      .click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy', exact: true }).click()

    // Waits for the copy to land; the paste below is what proves it.
    await expect
      .poll(() =>
        electronApp.evaluate(({ clipboard }) =>
          clipboard.readBuffer('FileNameW').toString('utf16le').replace(/\0+$/, '')
        )
      )
      .toBe(path.join(source, FILE_NAME))

    await shellPasteInto(pasteTarget)
    await expect
      .poll(() => readFile(path.join(pasteTarget, FILE_NAME), 'utf8').catch(() => null))
      .toBe('copied through the clipboard\n')
  })
})

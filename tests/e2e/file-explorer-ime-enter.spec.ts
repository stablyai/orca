import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'

test.use({ seedTestRepo: false })

const cases = (['New File', 'New Folder', 'Rename'] as const).flatMap((operation) =>
  [false, true].map((redispatch) => ({ operation, redispatch }))
)

for (const { operation, redispatch } of cases) {
  test(`IME confirmation keeps File Explorer ${operation} open (${redispatch ? 'redispatch' : 'continued typing'})`, async ({
    orcaPage: page,
    registerPostElectronShutdownCleanup
  }) => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'orca-ime-names-'))
    registerPostElectronShutdownCleanup(() => rm(folder, { recursive: true, force: true }))
    await writeFile(path.join(folder, 'original.md'), 'Keep this content\n')
    await page.evaluate(async (folder) => {
      await window.__store!.getState().addRepoPath(folder, 'folder')
    }, folder)
    await page
      .getByRole('option')
      .filter({ hasText: path.basename(folder) })
      .click()
    const explorer = page.locator('[data-orca-explorer-shell]')
    await explorer
      .getByRole('button', { name: 'original.md', exact: true })
      .click({ button: 'right' })
    await page.getByRole('menuitem', { name: operation, exact: operation !== 'Rename' }).click()
    const input = explorer.locator('input.border-ring')
    await expect(input).toBeFocused()
    await input.fill('')
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.imeSetComposition', {
      text: 'ぎじろく',
      selectionStart: 4,
      selectionEnd: 4
    })
    await cdp.send('Input.imeSetComposition', {
      text: '議事録',
      selectionStart: 3,
      selectionEnd: 3
    })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: redispatch ? 'Process' : 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 229,
      nativeVirtualKeyCode: 229
    })
    await cdp.send('Input.insertText', { text: '議事録' })
    if (redispatch) {
      await input.evaluate((element) => {
        const redispatchAfterRelease = (event: KeyboardEvent): void => {
          if (event.target !== element || event.key !== 'Process' || event.keyCode !== 229) {
            return
          }
          document.removeEventListener('keyup', redispatchAfterRelease)
          const confirmation = new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'Enter',
            code: 'Enter',
            keyCode: 13
          })
          element.setAttribute(
            'data-ime-redispatch-cancelled',
            String(!element.dispatchEvent(confirmation))
          )
        }
        // Run after React's keyup handler, before a frame can separate two CDP messages.
        document.addEventListener('keyup', redispatchAfterRelease)
      })
    }
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: redispatch ? 'Process' : 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: redispatch ? 229 : 13,
      nativeVirtualKeyCode: redispatch ? 229 : 13
    })
    if (redispatch) {
      await expect(input).toHaveAttribute('data-ime-redispatch-cancelled', 'true')
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13
      })
    }
    await expect(input).toBeVisible()
    await expect(input).toHaveValue('議事録')
    await expect(explorer.getByRole('button', { name: '議事録', exact: true })).toHaveCount(0)
    const suffix = redispatch ? '' : operation === 'New Folder' ? '-完成' : '.md'
    if (suffix) {
      await input.press('End')
      await input.pressSequentially(suffix)
    }
    await input.press('Enter')
    await expect(input).toHaveCount(0)
    await expect(
      explorer.getByRole('button', { name: `議事録${suffix}`, exact: true })
    ).toBeVisible()
    expect((await stat(path.join(folder, `議事録${suffix}`))).isDirectory()).toBe(
      operation === 'New Folder'
    )
    await cdp.detach()
  })
}

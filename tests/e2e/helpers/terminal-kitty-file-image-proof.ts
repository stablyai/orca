import { expect, type ElectronApplication, type Page } from '@stablyai/playwright-test'
import { PNG } from 'pngjs'
import { quotePosixShell } from '../../../src/shared/shell-argument-quoting'
import { nodeTerminalCommand } from '../terminal-node-command'
import { execInTerminal, waitForTerminalOutput } from './terminal'
import { readInlineImageState } from './terminal-inline-image-proof'

export type KittyFileImageColor = 'cyan' | 'magenta'

export function kittyFileImageFixture(color: KittyFileImageColor = 'cyan') {
  const png = new PNG({ width: 120, height: 36 })
  const rgba = color === 'cyan' ? [40, 240, 240, 255] : [240, 40, 240, 255]
  for (let index = 0; index < png.data.length; index += 4) {
    png.data.set(rgba, index)
  }
  const rows = ['\u0305', '\u030D', '\u030E']
  const cells = rows.map((row) => `\u{10EEEE}${row}${'\u{10EEEE}'.repeat(14)}`).join('\r\n')
  const payload =
    `\r\nFile-backed Kitty image\r\n` +
    `\x1b_Ga=T,t=f,f=100,i=61680,U=1,c=15,r=3,q=2;FILE_PATH_BASE64\x1b\\` +
    `\x1b[38;2;0;240;240m${cells}\x1b[0m\r\n`
  return { png: PNG.sync.write(png).toString('base64'), payload }
}

export function kittyFileImageProducer(
  filePathExpression: string,
  color: KittyFileImageColor = 'cyan'
): string {
  const fixture = kittyFileImageFixture(color)
  return [
    `const filePath = ${filePathExpression};`,
    `writeFileSync(filePath, Buffer.from('${fixture.png}', 'base64'));`,
    `const payload = Buffer.from('${Buffer.from(fixture.payload).toString('base64')}', 'base64').toString();`,
    `process.stdout.write(payload.replace('FILE_PATH_BASE64', Buffer.from(filePath).toString('base64')));`
  ].join('\n')
}

export async function assertKittyFileImagePixels(
  page: Page,
  screenshotPath: string,
  color: KittyFileImageColor = 'cyan'
): Promise<void> {
  const screen = page.locator('.pane:visible .xterm-screen').first()
  await expect
    .poll(
      async () => {
        const png = PNG.sync.read(await screen.screenshot({ path: screenshotPath }))
        let pixels = 0
        for (let index = 0; index < png.data.length; index += 4) {
          const [r, g, b] = png.data.subarray(index, index + 3)
          if (b > 220 && (color === 'cyan' ? g > 220 && r < 60 : r > 220 && g < 60)) {
            pixels++
          }
        }
        return pixels
      },
      { timeout: 30_000, message: `File-backed Kitty placeholders must paint ${color} pixels` }
    )
    .toBeGreaterThan(1000)
  await expect
    .poll(() => readInlineImageState(page))
    .toMatchObject({ images: 5, pending: 0, decoderBytes: 0 })
}

export async function blockLocalKittyFileReads(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    if (!('_invokeHandlers' in ipcMain) || !(ipcMain._invokeHandlers instanceof Map)) {
      throw new Error('Missing Electron invoke registry')
    }
    const original = ipcMain._invokeHandlers.get('runtime:call')
    if (typeof original !== 'function') {
      throw new Error('Missing local runtime RPC handler')
    }
    ipcMain.removeHandler('runtime:call')
    ipcMain.handle('runtime:call', (event, args: { method: string; params?: unknown }) => {
      if (args.method === 'terminal.readKittyFile') {
        throw new Error('File images must be read by the paired execution host')
      }
      return original(event, args)
    })
  })
}

export async function proveWindowsKittyFileImage(
  page: Page,
  ptyId: string,
  runtime: 'native' | 'wsl',
  screenshotPath: string
): Promise<void> {
  const name = `orca-kitty-file-${crypto.randomUUID()}.png`
  const fixture = kittyFileImageFixture()
  const marker = 'WINDOWS_KITTY_FILE_IMAGE_DONE'
  const expression = `require('node:path').join(require('node:os').tmpdir(), ${JSON.stringify(name)})`
  const linuxPath = `/tmp/${name}`
  const payload = Buffer.from(fixture.payload).toString('base64')
  const command =
    runtime === 'native'
      ? nodeTerminalCommand([
          '-e',
          `const {writeFileSync} = require('node:fs'); ${kittyFileImageProducer(expression)} console.log('${marker}');`
        ])
      : `printf '%s' '${fixture.png}' | base64 -d > ${quotePosixShell(linuxPath)}; orca_image_path=$(printf '%s' ${quotePosixShell(linuxPath)} | base64 -w0); orca_image_payload=$(printf '%s' '${payload}' | base64 -d); printf '%s' "\${orca_image_payload/FILE_PATH_BASE64/$orca_image_path}"; printf '\\r\\n%s\\r\\n' '${marker}'`
  try {
    await execInTerminal(page, ptyId, command)
    await waitForTerminalOutput(page, marker, 30_000)
    await assertKittyFileImagePixels(page, screenshotPath)
  } catch (error) {
    if (runtime === 'wsl') {
      const diagnostic = await diagnoseWslKittyFileRead(page, ptyId, linuxPath).catch(() => ({
        stage: 'diagnostic-unavailable'
      }))
      console.log('WSL Kitty file read diagnostic:', JSON.stringify(diagnostic))
    }
    throw error
  } finally {
    await execInTerminal(
      page,
      ptyId,
      runtime === 'native'
        ? nodeTerminalCommand(['-e', `require('node:fs').rmSync(${expression}, {force:true});`])
        : `rm -f -- ${quotePosixShell(linuxPath)}`
    )
  }
}

async function diagnoseWslKittyFileRead(page: Page, ptyId: string, path: string) {
  return page.evaluate(
    async ({ ptyId, path }) => {
      function failure(stage: string, error: { code: string; message: string }) {
        const message = error.message
          .replace(/(['"])[\s\S]*?\1/g, '<redacted>')
          .replace(/\S*(?:[/\\]|[a-z]:)\S*/gi, '<path>')
          .slice(0, 400)
        const filesystem = error.message.match(/^([A-Z][A-Z_]+):[^,]*, ([a-z]+)\b/)
        return {
          stage,
          code: /^[a-z_]+$/i.test(error.code) ? error.code : 'unknown',
          errno: filesystem?.[1],
          syscall: filesystem?.[2],
          message
        }
      }
      const state = window.__store!.getState()
      const tabId = state.activeTabId
      const pane = tabId && window.__paneManagers?.get(tabId)?.getActivePane()
      if (!pane || pane.container.dataset.ptyId !== ptyId) {
        return { stage: 'binding-changed' }
      }
      const resolved = await window.api.runtime.call({
        method: 'terminal.resolvePane',
        params: { paneKey: `${tabId}:${pane.leafId}`, worktreeId: state.activeWorktreeId }
      })
      if (!resolved.ok) {
        return failure('resolve-pane', resolved.error)
      }
      const result = resolved.result
      if (typeof result !== 'object' || result === null || !('terminal' in result)) {
        return { stage: 'invalid-resolution' }
      }
      const terminal = result.terminal
      if (
        typeof terminal !== 'object' ||
        terminal === null ||
        !('handle' in terminal) ||
        !('ptyId' in terminal) ||
        terminal.ptyId !== ptyId
      ) {
        return { stage: 'binding-changed' }
      }
      const read = await window.api.runtime.call({
        method: 'terminal.readKittyFile',
        params: {
          terminal: terminal.handle,
          path,
          ...('incarnationId' in terminal ? { expectedIncarnationId: terminal.incarnationId } : {})
        }
      })
      if (!read.ok) {
        return failure('read-file', read.error)
      }
      const bytes = read.result
      return {
        stage: 'read-file',
        png:
          typeof bytes === 'object' &&
          bytes !== null &&
          'base64' in bytes &&
          typeof bytes.base64 === 'string' &&
          bytes.base64.startsWith('iVBORw0KGgo')
      }
    },
    { ptyId, path }
  )
}

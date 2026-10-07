import { expect, type Page } from '@stablyai/playwright-test'
import { PNG } from 'pngjs'

export function inlineImagePayload(includePlaceholders = false): string {
  const png = new PNG({ width: 120, height: 36 })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data.set([240, 40, 40, 255], i)
  }
  const encoded = PNG.sync.write(png).toString('base64')
  let placeholderPayload = ''
  if (includePlaceholders) {
    for (let i = 0; i < png.data.length; i += 4) {
      png.data.set([240, 160, 40, 255], i)
    }
    const prototype = PNG.sync.write(png).toString('base64')
    const rows = ['\u0305', '\u030D', '\u030E']
    const cells = rows.map((row) => `\u{10EEEE}${row}${'\u{10EEEE}'.repeat(14)}`).join('\r\n')
    placeholderPayload =
      `Kitty placeholders: orange\r\n` +
      `\x1b_Ga=T,f=100,i=65280,U=1,c=15,r=3,q=2;${prototype}\x1b\\` +
      `\x1b[38;2;0;255;0m${cells}\x1b[0m\r\n\r\n`
  }
  return (
    `\x1bcSSH / REMOTE INLINE IMAGE PROOF\r\n\r\n` +
    `iTerm2: red\r\n` +
    `\x1b]1337;File=inline=1;width=120px;height=36px:${encoded}\x07` +
    `\r\n\r\nSIXEL: green\r\n` +
    `\x1bPq"1;1;120;36#0;2;0;100;0${'#0!120~-'.repeat(6)}\x1b\\` +
    `\r\n\r\nKitty: blue\r\n` +
    `\x1b_Ga=T,f=24,s=120,v=36,q=2;${Buffer.from(
      Array.from({ length: 120 * 36 }, () => [40, 40, 240]).flat()
    ).toString('base64')}\x1b\\` +
    `\r\n\r\n${placeholderPayload}`
  )
}

export function inlineImageProducer(includePlaceholders = false): string {
  const payload = inlineImagePayload(includePlaceholders)
  return (
    `const payload = Buffer.from('${Buffer.from(payload).toString('base64')}', 'base64');\n` +
    `process.stdout.write(payload);\n` +
    `console.log('IMAGE_PROOF_' + process.argv[2]);\n`
  )
}

export async function enableInlineImages(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__store!.getState().updateSettings({ terminalInlineImages: true })
  })
  await expect.poll(() => readInlineImageState(page), { timeout: 30_000 }).not.toBeNull()
}

export type InlineImageResources = {
  id: string
  mounted: boolean
  addon: boolean
  images: number
  storageMB: number
  pending: number
  decoderBytes: number
  encodedBytes: number
}

/** One walk of the addon's private state, shared by every image spec so the
 *  internals contract against the patched dependency has a single definition. */
export async function readInlineImageResources(
  page: Page,
  tabIds: string[]
): Promise<InlineImageResources[]> {
  return page.evaluate((ids) => {
    type Addon = {
      _storage?: { _images: Map<number, unknown> }
      _handlers?: Map<
        string,
        {
          _pendingTransmissions?: Map<number, { decoder: { _mem: { buffer: ArrayBuffer } } }>
          _kittyStorage?: { images: Map<number, { data: Uint8Array }> }
        }
      >
      storageUsage?: number
    }
    return ids.map((id) => {
      const manager = window.__paneManagers?.get(id)
      const terminal = manager?.getActivePane()?.terminal
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm private addon state is intentionally inspected by this proof helper.
      const internals = terminal as unknown as
        | { _addonManager: { _addons: { instance: Addon }[] } }
        | undefined
      const addon = internals?._addonManager._addons
        .map((entry) => entry.instance)
        .find((entry) => entry._handlers?.has('kitty'))
      const kitty = addon?._handlers?.get('kitty')
      const pending = [...(kitty?._pendingTransmissions?.values() ?? [])]
      return {
        id,
        mounted: Boolean(manager),
        addon: Boolean(addon),
        images: addon?._storage?._images.size ?? 0,
        storageMB: addon?.storageUsage ?? 0,
        pending: pending.length,
        decoderBytes: pending.reduce(
          (sum, upload) => sum + upload.decoder._mem.buffer.byteLength,
          0
        ),
        encodedBytes: [...(kitty?._kittyStorage?.images.values() ?? [])].reduce(
          (sum, image) => sum + image.data.byteLength,
          0
        )
      }
    })
  }, tabIds)
}

/** Active pane only; null when no image addon is attached. */
export async function readInlineImageState(page: Page) {
  const activeTabId = await page.evaluate(() => window.__store!.getState().activeTabId)
  if (!activeTabId) {
    return null
  }
  const [resources] = await readInlineImageResources(page, [activeTabId])
  if (!resources?.addon) {
    return null
  }
  const { images, storageMB, pending, decoderBytes, encodedBytes } = resources
  return { images, storageMB, pending, decoderBytes, encodedBytes }
}

export async function assertInlineImagePixels(page: Page, screenshotPath: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const png = PNG.sync.read(await page.screenshot({ path: screenshotPath }))
        const counts = [0, 0, 0]
        for (let i = 0; i < png.data.length; i += 4) {
          const [r, g, b] = png.data.subarray(i, i + 3)
          if (r > 220 && g < 60 && b < 60) {
            counts[0]++
          }
          if (g > 220 && r < 60 && b < 60) {
            counts[1]++
          }
          if (b > 220 && r < 60 && g < 60) {
            counts[2]++
          }
        }
        return Math.min(...counts)
      },
      {
        timeout: 30_000,
        message: 'All three protocol images must appear in the rendered screenshot'
      }
    )
    .toBeGreaterThan(1000)
}

export async function assertKittyPlaceholderPixels(
  page: Page,
  screenshotPath: string
): Promise<void> {
  const screen = page.locator('.pane:visible .xterm-screen').first()
  const grid = await page.evaluate(() => {
    const tab = window.__store!.getState().activeTabId
    const terminal = tab && window.__paneManagers?.get(tab)?.getActivePane()?.terminal
    const cell = terminal && terminal.dimensions?.css.cell
    if (!terminal || !cell) {
      throw new Error('Missing placeholder proof geometry')
    }
    for (let row = 0; row < terminal.rows; row++) {
      const line = terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)
      if (line?.translateToString(true).includes('Kitty placeholders: orange')) {
        return { row: row + 1, width: cell.width, height: cell.height }
      }
    }
    throw new Error('Missing placeholder proof label in viewport')
  })
  await expect
    .poll(
      async () => {
        const png = PNG.sync.read(await screen.screenshot({ path: screenshotPath }))
        let orangePixels = 0
        for (let i = 0; i < png.data.length; i += 4) {
          if (
            png.data[i] > 220 &&
            png.data[i + 1] > 140 &&
            png.data[i + 1] < 180 &&
            png.data[i + 2] < 60
          ) {
            orangePixels++
          }
        }
        const bounds = await screen.boundingBox()
        if (!bounds) {
          throw new Error('Missing placeholder proof screen bounds')
        }
        const cw = (grid.width * png.width) / bounds.width
        const ch = (grid.height * png.height) / bounds.height
        let glyphPixels = 0
        for (let y = Math.ceil(grid.row * ch); y < (grid.row + 3) * ch; y++) {
          for (let x = 0; x < 15 * cw; x++) {
            const i = (y * png.width + x) * 4
            const red = png.data[i]
            const green = png.data[i + 1]
            const blue = png.data[i + 2]
            if (red < 110 && green > 120 && blue < 110 && green > red + 40 && green > blue + 40) {
              glyphPixels++
            }
          }
        }
        expect(glyphPixels, 'Placeholder glyphs must not show through the fitted image').toBe(0)
        return orangePixels
      },
      { timeout: 30_000, message: 'Remote Kitty placeholder cells must paint the orange image' }
    )
    .toBeGreaterThan(1000)
}

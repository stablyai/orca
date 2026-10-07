import { writeFileSync } from 'node:fs'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { execInTerminal, waitForTerminalOutput } from './helpers/terminal'
import { assertLayerImagePixels, prepareLayerImage } from './helpers/terminal-inline-image-layers'
import {
  assertInlineImagePixels,
  assertKittyPlaceholderPixels,
  inlineImageProducer
} from './helpers/terminal-inline-image-proof'
import { nodeTerminalCommand } from './terminal-node-command'

async function readPlaceholderGlyphs(page: Page, removeProvider = false) {
  return page.evaluate((remove) => {
    const tab = window.__store!.getState().activeTabId
    const terminal = tab && window.__paneManagers?.get(tab)?.getActivePane()?.terminal
    if (!terminal) {
      throw new Error('Missing placeholder terminal')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This proof checks the installed DOM/GPU renderer's model and provider below.
    const internals = terminal as unknown as {
      _core: {
        _renderService: {
          _renderer: {
            value: {
              _model?: { cells: Uint32Array }
              setImageLayerProvider: (provider: undefined) => void
            }
          }
        }
      }
    }
    const renderer = internals._core._renderService._renderer.value
    if (remove) {
      renderer.setImageLayerProvider(undefined)
    }
    let bufferCells = 0
    let paintedGlyphCells = 0
    for (let y = 0; y < terminal.rows; y++) {
      const line = terminal.buffer.active.getLine(terminal.buffer.active.viewportY + y)
      for (let x = 0; x < terminal.cols; x++) {
        if (line?.getCell(x)?.getChars().codePointAt(0) !== 0x10eeee) {
          continue
        }
        bufferCells++
        if (
          renderer._model &&
          !(renderer._model.cells[(y * terminal.cols + x) * 4 + 2] & 0x40000000)
        ) {
          paintedGlyphCells++
        }
      }
    }
    if (!renderer._model) {
      paintedGlyphCells = Array.from(
        terminal.element?.querySelector('.xterm-rows')?.textContent ?? ''
      ).filter((char) => char.codePointAt(0) === 0x10eeee).length
    }
    return { bufferCells, paintedGlyphCells }
  }, removeProvider)
}

for (const acceleration of ['off', 'on'] as const) {
  test(`${acceleration}: canvas sources preserve protocols and layering without the bitmap API`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(() => {
      Object.defineProperty(window, 'createImageBitmap', { value: undefined, configurable: true })
    })
    const pty = await prepareLayerImage(orcaPage, testInfo, acceleration, -1, 128)
    await assertLayerImagePixels(orcaPage, testInfo.outputPath('canvas-layers.png'), -1, 128)
    const producer = testInfo.outputPath('canvas-protocols.cjs')
    writeFileSync(producer, inlineImageProducer(true))
    await execInTerminal(orcaPage, pty, nodeTerminalCommand([producer, 'CANVAS']))
    await waitForTerminalOutput(orcaPage, 'IMAGE_PROOF_CANVAS', 30_000)
    await assertInlineImagePixels(orcaPage, testInfo.outputPath('canvas-protocols.png'))
    await assertKittyPlaceholderPixels(orcaPage, testInfo.outputPath('canvas-placeholders.png'))
    expect(await orcaPage.evaluate(() => typeof window.createImageBitmap)).toBe('undefined')
    expect(await readPlaceholderGlyphs(orcaPage)).toEqual({ bufferCells: 45, paintedGlyphCells: 0 })
    await readPlaceholderGlyphs(orcaPage, true)
    await expect
      .poll(() => readPlaceholderGlyphs(orcaPage))
      .toEqual({
        bufferCells: 45,
        paintedGlyphCells: 45
      })
  })
}

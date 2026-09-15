import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { nodeTerminalCommand } from './terminal-node-command'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

// Why a hand-built PNG: the spec must not depend on a binary fixture or an
// image library — a 16×16 solid red square is enough to prove the sequence was
// decoded and placed into the buffer.
const IMAGE_SIZE = 16
const IMAGE_ROWS = 4
const IMAGE_COLS = 8

function crc32(bytes: Uint8Array): number {
  let crc = -1
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ -1) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([length, typeBytes, data, crc])
}

function solidRedPngBase64(): string {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(IMAGE_SIZE, 0)
  header.writeUInt32BE(IMAGE_SIZE, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // RGB
  const raw = Buffer.alloc((1 + IMAGE_SIZE * 3) * IMAGE_SIZE)
  for (let y = 0; y < IMAGE_SIZE; y += 1) {
    const rowStart = y * (1 + IMAGE_SIZE * 3)
    raw[rowStart] = 0 // filter: none
    for (let x = 0; x < IMAGE_SIZE; x += 1) {
      raw[rowStart + 1 + x * 3] = 0xff
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]).toString('base64')
}

type ImageProbe = {
  imageAddonLoaded: boolean
  markerRow: number | null
  imageCellsHit: number
  redPixelFound: boolean
}

async function probeInlineImage(page: Page, marker: string): Promise<ImageProbe> {
  return page.evaluate(
    ({ marker, rows, cols }) => {
      const state = window.__store?.getState()
      const worktreeId = state?.activeWorktreeId
      const tabId =
        state?.activeTabType === 'terminal'
          ? (state.activeTabId ?? null)
          : worktreeId
            ? (state.activeTabIdByWorktree?.[worktreeId] ?? null)
            : null
      const manager = tabId ? window.__paneManagers?.get(tabId) : null
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      if (!pane) {
        throw new Error('active terminal pane unavailable')
      }
      const buffer = pane.terminal.buffer.active
      let markerRow: number | null = null
      for (let row = 0; row < buffer.length; row += 1) {
        if (buffer.getLine(row)?.translateToString(true).includes(marker)) {
          markerRow = row
        }
      }
      const addon = pane.imageAddon ?? null
      let imageCellsHit = 0
      let redPixelFound = false
      if (addon && markerRow !== null) {
        for (let row = markerRow - rows; row < markerRow; row += 1) {
          for (let col = 0; col < cols; col += 1) {
            const canvas = addon.getImageAtBufferCell(col, row)
            if (!canvas) {
              continue
            }
            imageCellsHit += 1
            const pixel = canvas.getContext('2d')?.getImageData(1, 1, 1, 1).data
            if (
              pixel &&
              pixel[0] === 0xff &&
              pixel[1] === 0 &&
              pixel[2] === 0 &&
              pixel[3] === 0xff
            ) {
              redPixelFound = true
            }
          }
        }
      }
      return { imageAddonLoaded: addon !== null, markerRow, imageCellsHit, redPixelFound }
    },
    { marker, rows: IMAGE_ROWS, cols: IMAGE_COLS }
  )
}

async function captureProof(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(name), animations: 'disabled' })
}

test.describe('terminal inline images', () => {
  test('decodes an iTerm2 inline image sequence into the terminal buffer', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage)

    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, ptyId, 15_000)

    const marker = `ORCA_INLINE_IMAGE_${randomUUID().slice(0, 8)}`
    const scriptDir = mkdtempSync(path.join(os.tmpdir(), 'orca-inline-image-'))
    const scriptPath = path.join(scriptDir, 'print-inline-image.js')
    // Why a script rather than printf: the sequence must reach the PTY byte for
    // byte on every platform's shell, and Windows has no printf.
    writeFileSync(
      scriptPath,
      [
        `const image = ${JSON.stringify(solidRedPngBase64())}`,
        `process.stdout.write('\\x1b]1337;File=inline=1;width=${IMAGE_COLS};height=${IMAGE_ROWS};preserveAspectRatio=0:' + image + '\\x07\\n')`,
        `process.stdout.write(${JSON.stringify(marker)} + '\\n')`
      ].join('\n')
    )
    try {
      await sendToTerminal(orcaPage, ptyId, `${nodeTerminalCommand([scriptPath])}\r`)
      await waitForTerminalOutput(orcaPage, marker)

      await expect
        .poll(() => probeInlineImage(orcaPage, marker), {
          timeout: 10_000,
          message: 'inline image was not decoded into the terminal buffer'
        })
        .toMatchObject({
          imageAddonLoaded: true,
          imageCellsHit: IMAGE_ROWS * IMAGE_COLS,
          redPixelFound: true
        })
      await captureProof(orcaPage, testInfo, 'terminal-inline-image-after.png')
    } finally {
      rmSync(scriptDir, { recursive: true, force: true })
    }
  })
})

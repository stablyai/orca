import type { Page } from '@stablyai/playwright-test'
import { writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { expect, test } from './helpers/orca-app'
import { execInTerminal, waitForActivePanePtyId, waitForTerminalOutput } from './helpers/terminal'
import { nodeTerminalCommand } from './terminal-node-command'
import { prepareLayerImage } from './helpers/terminal-inline-image-layers'

async function assertImagePixels(page: Page, path: string): Promise<void> {
  await expect
    .poll(async () => {
      const png = PNG.sync.read(
        await page.locator('.pane:visible .xterm-screen').first().screenshot({ path })
      )
      let red = 0
      for (let i = 0; i < png.data.length; i += 4) {
        if (png.data[i] > 220 && png.data[i + 1] < 60 && png.data[i + 2] < 60) {
          red++
        }
      }
      return red
    })
    .toBeGreaterThan(1000)
}

async function captureTextures(page: Page, expectedSources = 2) {
  return page.evaluateHandle((expected) => {
    const tab = window.__store!.getState().activeTabId
    const terminal = tab && window.__paneManagers?.get(tab)?.getActivePane()?.terminal
    type ImageRenderer = {
      _textures: Map<unknown, { tiles: { texture: WebGLTexture }[] }>
      _textureBytes: number
      _textureCount: number
      render: (
        draws: {
          source: HTMLCanvasElement
          sourceRect: [number, number, number, number]
          targetRect: [number, number, number, number]
          behindCellBackground: boolean
        }[],
        behindBackground: boolean,
        viewport: { width: number; height: number }
      ) => void
      endFrame: () => void
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this proof inspects the patched renderer's resources and checks their existence below.
    const internals = terminal as unknown as {
      _core: {
        _renderService: {
          _renderer: {
            value: { _gl: WebGL2RenderingContext; _imageRenderer: { value?: ImageRenderer } }
          }
        }
      }
    }
    const renderer = internals?._core._renderService._renderer.value
    const image = renderer?._imageRenderer.value
    if (!image || image._textures.size !== expected) {
      throw new Error(`Expected ${expected} actual image sources`)
    }
    return {
      gl: renderer._gl,
      image,
      textures: [...image._textures.values()].flatMap((entry) =>
        entry.tiles.map((tile) => tile.texture)
      )
    }
  }, expectedSources)
}

test('renderer switches and reset release actual image textures without retransmitting', async ({
  orcaPage
}, testInfo) => {
  const pty = await prepareLayerImage(orcaPage, testInfo, 'on', -1, 255)
  await assertImagePixels(orcaPage, testInfo.outputPath('gpu-before.png'))
  const original = await captureTextures(orcaPage)
  expect(
    await original.evaluate(({ gl, textures }) => textures.every((t) => gl.isTexture(t)))
  ).toBe(true)
  try {
    await orcaPage.evaluate(async () => {
      await window.__store!.getState().updateSettings({ terminalGpuAcceleration: 'off' })
    })
    await assertImagePixels(orcaPage, testInfo.outputPath('dom-after.png'))
    expect(await waitForActivePanePtyId(orcaPage)).toBe(pty)
    await expect
      .poll(() =>
        original.evaluate(({ image, gl, textures }) => ({
          count: image._textures.size,
          bytes: image._textureBytes,
          live: textures.filter((t) => gl.isTexture(t)).length
        }))
      )
      .toEqual({ count: 0, bytes: 0, live: 0 })

    await orcaPage.evaluate(async () => {
      await window.__store!.getState().updateSettings({ terminalGpuAcceleration: 'on' })
    })
    await expect
      .poll(() =>
        orcaPage.evaluate(() => {
          const tab = window.__store!.getState().activeTabId
          const manager = tab && window.__paneManagers?.get(tab)
          const pane = manager && manager.getActivePane()
          return Boolean(manager && pane && manager.hasWebglRenderer(pane.id))
        })
      )
      .toBe(true)
    await assertImagePixels(orcaPage, testInfo.outputPath('gpu-return.png'))
    expect(await waitForActivePanePtyId(orcaPage)).toBe(pty)
    const replacement = await captureTextures(orcaPage)
    try {
      await orcaPage.evaluate(() => {
        const tab = window.__store!.getState().activeTabId
        window.__paneManagers?.get(tab!)?.getActivePane()?.terminal.reset()
      })
      await expect
        .poll(() =>
          replacement.evaluate(({ image, gl, textures }) => ({
            count: image._textures.size,
            bytes: image._textureBytes,
            live: textures.filter((t) => gl.isTexture(t)).length
          }))
        )
        .toEqual({ count: 0, bytes: 0, live: 0 })
    } finally {
      await replacement.dispose()
    }
  } finally {
    await original.dispose()
  }
})

test('valid sources wider than MAX_TEXTURE_SIZE paint through bounded GPU tiles', async ({
  orcaPage
}, testInfo) => {
  const pty = await prepareLayerImage(orcaPage, testInfo, 'on', -1, 255)
  const initial = await captureTextures(orcaPage)
  let width: number
  try {
    width = await initial.evaluate(({ gl }) => Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) + 1)
  } finally {
    await initial.dispose()
  }
  const png = new PNG({ width, height: 120 })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data.set([240, 40, 40, 255], i)
  }
  const payload = `\x1bc\x1b[3;3H\x1b_Ga=T,f=100,i=90,C=1,z=-1,q=2;${PNG.sync.write(png).toString('base64')}\x1b\\\x1b[16;1HWIDE_IMAGE_DONE\r\n`
  const producer = testInfo.outputPath('wide-gpu-image.cjs')
  writeFileSync(
    producer,
    `process.stdout.write(Buffer.from('${Buffer.from(payload).toString('base64')}', 'base64'))`
  )
  await execInTerminal(orcaPage, pty, nodeTerminalCommand([producer]))
  await waitForTerminalOutput(orcaPage, 'WIDE_IMAGE_DONE', 30_000)
  await assertImagePixels(orcaPage, testInfo.outputPath('wide-gpu-image.png'))
  const tiled = await captureTextures(orcaPage, 1)
  try {
    expect(
      await tiled.evaluate(({ gl, image, textures }) => ({
        textures: textures.length,
        live: textures.filter((t) => gl.isTexture(t)).length,
        bytes: image._textureBytes
      }))
    ).toEqual({ textures: 2, live: 2, bytes: width * 120 * 4 })
  } finally {
    await tiled.dispose()
  }
})

test('context restoration repaints decoded images without retransmission', async ({
  orcaPage
}, testInfo) => {
  const pty = await prepareLayerImage(orcaPage, testInfo, 'on', -1, 255)
  await assertImagePixels(orcaPage, testInfo.outputPath('context-before.png'))
  const original = await captureTextures(orcaPage)
  try {
    await original.evaluate(({ gl }) => {
      const extension = gl.getExtension('WEBGL_lose_context')
      if (!extension) {
        throw new Error('Context loss extension unavailable')
      }
      extension.loseContext()
      setTimeout(() => extension.restoreContext(), 100)
    })
    await expect.poll(() => original.evaluate(({ image }) => image._textures.size)).toBe(0)
    await assertImagePixels(orcaPage, testInfo.outputPath('context-restored.png'))
    expect(await waitForActivePanePtyId(orcaPage)).toBe(pty)
    const restored = await captureTextures(orcaPage)
    try {
      expect(
        await restored.evaluate(({ gl, textures }) => textures.every((t) => gl.isTexture(t)))
      ).toBe(true)
    } finally {
      await restored.dispose()
    }
  } finally {
    await original.dispose()
  }
})

test('GPU cache caps bytes and releases allocations after an upload exception', async ({
  orcaPage
}, testInfo) => {
  await prepareLayerImage(orcaPage, testInfo, 'on', -1, 255)
  await assertImagePixels(orcaPage, testInfo.outputPath('budget-initial.png'))
  const resources = await captureTextures(orcaPage)
  try {
    const result = await resources.evaluate(({ image, gl }) => {
      const sources = Array.from({ length: 9 }, () => {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1024
        const context = canvas.getContext('2d')
        if (!context) {
          throw new Error('Budget source canvas unavailable')
        }
        context.fillStyle = '#f02828'
        context.fillRect(0, 0, 1024, 1024)
        return canvas
      })
      const draws: Parameters<typeof image.render>[0] = sources.map((source, index) => ({
        source,
        sourceRect: [0, 0, 1024, 1024],
        targetRect: [index * 40, 0, 32, 32],
        behindCellBackground: false
      }))
      const originalUpload = gl.texImage2D
      const originalCreate = gl.createTexture
      const failedTextures: WebGLTexture[] = []
      let retained: WebGLTexture[] = []
      try {
        image.endFrame()
        image.render(draws, false, { width: 512, height: 512 })
        retained = [...image._textures.values()].flatMap((entry) =>
          entry.tiles.map((t) => t.texture)
        )
        const budget = {
          bytes: image._textureBytes,
          count: image._textureCount,
          live: retained.filter((texture) => gl.isTexture(texture)).length
        }
        image.endFrame()
        image.endFrame()
        const freed = {
          bytes: image._textureBytes,
          count: image._textureCount,
          live: retained.filter((texture) => gl.isTexture(texture)).length
        }
        gl.createTexture = () => {
          const texture = originalCreate.call(gl)
          if (texture) {
            failedTextures.push(texture)
          }
          return texture
        }
        gl.texImage2D = () => {
          throw new Error('Injected image upload failure')
        }
        image.render(draws.slice(0, 1), false, { width: 512, height: 512 })
        const failed = {
          allocated: failedTextures.length,
          bytes: image._textureBytes,
          count: image._textureCount,
          live: failedTextures.filter((texture) => gl.isTexture(texture)).length,
          premultiply: gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL)
        }
        return { budget, freed, failed }
      } finally {
        gl.texImage2D = originalUpload
        gl.createTexture = originalCreate
        image.endFrame()
        image.endFrame()
        for (const source of sources) {
          source.width = source.height = 0
        }
      }
    })
    expect(result).toEqual({
      budget: { bytes: 32 * 1024 * 1024, count: 8, live: 8 },
      freed: { bytes: 0, count: 0, live: 0 },
      failed: { allocated: 1, bytes: 0, count: 0, live: 0, premultiply: false }
    })
  } finally {
    await resources.dispose()
  }
})

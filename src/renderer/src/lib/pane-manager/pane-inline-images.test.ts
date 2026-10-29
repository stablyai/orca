import { beforeAll, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'

const { activation, disposeSpy } = vi.hoisted(() => ({
  activation: { fail: false },
  disposeSpy: vi.fn()
}))

vi.mock('@xterm/addon-image', () => ({
  ImageAddon: class {
    options: unknown
    disposed = false
    constructor(options?: unknown) {
      this.options = options
    }
    activate(): void {
      if (activation.fail) {
        throw new Error('partial activation')
      }
    }
    dispose(): void {
      this.disposed = true
      disposeSpy()
    }
  }
}))

import type { ManagedPaneInternal } from './pane-manager-types'
import { primeTerminalImageAddon } from './terminal-image-addon-loader'
import { attachInlineImages, detachInlineImages } from './pane-inline-images'

function makePane(id: number): ManagedPaneInternal {
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the pane members exercised by the addon lifecycle.
  return {
    id,
    terminal,
    imageAddon: null,
    imageAttachmentDeferred: false
  } as unknown as ManagedPaneInternal
}

describe('pane inline images', () => {
  // Most tests need a resolved addon; prime independently so file ordering cannot matter.
  beforeAll(async () => {
    await primeTerminalImageAddon()
  })

  it('attaches deferred panes once the addon chunk resolves', async () => {
    // Fresh modules expose the deferred path before the module-level addon memo resolves.
    vi.resetModules()
    const images = await import('./pane-inline-images')
    const loader = await import('./terminal-image-addon-loader')
    const pane = makePane(1)
    images.attachInlineImages(pane)

    expect(pane.imageAddon).toBeNull()
    expect(pane.imageAttachmentDeferred).toBe(true)

    await loader.primeTerminalImageAddon()

    expect(loader.getTerminalImageAddonConstructor()).not.toBeNull()
    expect(pane.imageAddon).not.toBeNull()
    expect(pane.imageAttachmentDeferred).toBe(false)
    images.detachInlineImages(pane)
    pane.terminal.dispose()
  })

  it('disposes a partially activated addon and allows a later retry', () => {
    const pane = makePane(7)
    const before = disposeSpy.mock.calls.length
    activation.fail = true
    try {
      attachInlineImages(pane)
      expect(pane.imageAddon).toBeNull()
      expect(disposeSpy).toHaveBeenCalledTimes(before + 1)
    } finally {
      activation.fail = false
    }
    attachInlineImages(pane)
    expect(pane.imageAddon).not.toBeNull()
    detachInlineImages(pane)
    pane.terminal.dispose()
  })
})

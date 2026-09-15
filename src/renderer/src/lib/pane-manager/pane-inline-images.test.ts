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
import {
  attachInlineImages,
  detachInlineImages,
  setInlineImagesEnabled,
  terminalRendersInlineImages
} from './pane-inline-images'

function makePane(id: number): ManagedPaneInternal {
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  return {
    id,
    terminal,
    imageAddon: null,
    imageAttachmentDeferred: false
  } as unknown as ManagedPaneInternal
}

describe('pane inline images', () => {
  // Every test below the deferred one wants the addon already resolved, so the
  // file has no ordering requirement in either direction.
  beforeAll(async () => {
    await primeTerminalImageAddon()
  })

  it('attaches deferred panes once the addon chunk resolves', async () => {
    // Fresh modules rather than "must run first": the deferred path only exists
    // while the module-level addon memo is still unresolved.
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

  it('attaches synchronously once the addon is loaded', () => {
    const pane = makePane(2)
    attachInlineImages(pane)
    expect(pane.imageAddon).not.toBeNull()
  })

  it('is idempotent — a second attach reuses the same addon', () => {
    const pane = makePane(3)
    attachInlineImages(pane)
    const first = pane.imageAddon
    attachInlineImages(pane)
    expect(pane.imageAddon).toBe(first)
  })

  it('disposes the addon on detach', () => {
    const pane = makePane(4)
    attachInlineImages(pane)
    const addon = pane.imageAddon as unknown as { disposed: boolean }
    detachInlineImages(pane)
    expect(pane.imageAddon).toBeNull()
    expect(addon.disposed).toBe(true)
  })

  it('toggles attach and detach through setInlineImagesEnabled', () => {
    const pane = makePane(5)
    setInlineImagesEnabled(pane, true)
    expect(pane.imageAddon).not.toBeNull()
    setInlineImagesEnabled(pane, false)
    expect(pane.imageAddon).toBeNull()
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

  it('reports inline-image rendering only while the addon is really attached', () => {
    const pane = makePane(8)
    expect(terminalRendersInlineImages(pane.terminal)).toBe(false)
    attachInlineImages(pane)
    expect(terminalRendersInlineImages(pane.terminal)).toBe(true)
    detachInlineImages(pane)
    expect(terminalRendersInlineImages(pane.terminal)).toBe(false)
    pane.terminal.dispose()
  })

  it('does not report rendering for a pane whose addon failed to activate', () => {
    const pane = makePane(9)
    activation.fail = true
    try {
      attachInlineImages(pane)
    } finally {
      activation.fail = false
    }
    expect(pane.imageAddon).toBeNull()
    expect(terminalRendersInlineImages(pane.terminal)).toBe(false)
    pane.terminal.dispose()
  })

  it('passes the perf-tuned options to the addon', () => {
    const pane = makePane(6)
    attachInlineImages(pane)
    const options = (pane.imageAddon as unknown as { options: Record<string, unknown> }).options
    expect(options.enableSizeReports).toBe(false)
    expect(options.storageLimit).toBe(32)
    expect(Number(options.pixelLimit) * 4).toBeLessThanOrEqual(
      Number(options.storageLimit) * 1000000
    )
    expect(options.sixelSizeLimit).toBe(8 * 1024 * 1024)
    expect(options.iipSizeLimit).toBe(8 * 1024 * 1024)
    expect(options.kittySizeLimit).toBe(8 * 1024 * 1024)
    // Pin the value, not the formula the source already states.
    expect(options.pixelLimit).toBe(8_000_000)
  })
})

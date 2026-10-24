import { expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import type { ManagedPaneInternal } from './pane-manager-types'
import { createLazyXtermAddonLoader } from './terminal-lazy-addon-loader'

it('recovers capped imports after disabling and enabling images', async () => {
  vi.resetModules()
  const load = vi.fn<() => Promise<new () => { activate(): void; dispose(): void }>>()
  load.mockRejectedValue(new Error('chunk unavailable'))
  const loader = createLazyXtermAddonLoader({ load, failureMessage: 'expected test failure' })
  vi.doMock('./terminal-image-addon-loader', () => ({
    setTerminalImageAddonLoadHandlers: loader.setHandlers,
    getTerminalImageAddonConstructor: loader.getConstructor,
    primeTerminalImageAddon: loader.prime,
    rearmTerminalImageAddonLoad: loader.rearm
  }))
  const images = await import('./pane-inline-images')
  const terminal = new Terminal({ allowProposedApi: true })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture includes all fields used by image attachment.
  const pane = {
    terminal,
    imageAddon: null,
    imageAttachmentDeferred: false,
    id: 1
  } as unknown as ManagedPaneInternal
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      images.setInlineImagesEnabled(pane, true)
      await loader.prime()
    }
    expect(load).toHaveBeenCalledTimes(3)
    expect(pane.imageAddon).toBeNull()
    load.mockResolvedValue(
      class {
        activate(): void {}
        dispose(): void {}
        onImageAdded(): { dispose: () => void } {
          return { dispose(): void {} }
        }
      }
    )
    images.setInlineImagesEnabled(pane, false)
    images.setInlineImagesEnabled(pane, true)
    await loader.prime()
    expect(load).toHaveBeenCalledTimes(4)
    expect(pane.imageAddon).not.toBeNull()
  } finally {
    images.detachInlineImages(pane)
    terminal.dispose()
    warning.mockRestore()
    vi.doUnmock('./terminal-image-addon-loader')
    vi.resetModules()
  }
})

it('does not duplicate an in-flight import when recovery is requested', async () => {
  let resolveImport: (value: string) => void = () => {}
  const pending = new Promise<string>((resolve) => {
    resolveImport = resolve
  })
  const load = vi.fn(() => pending)
  const loader = createLazyXtermAddonLoader({ load, failureMessage: 'load failed' })
  const first = loader.prime()
  loader.rearm()
  expect(loader.prime()).toBe(first)
  expect(load).toHaveBeenCalledTimes(1)
  resolveImport('ready')
  await first
  expect(loader.getConstructor()).toBe('ready')
})

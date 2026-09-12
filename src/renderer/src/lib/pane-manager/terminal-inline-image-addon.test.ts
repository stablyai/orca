import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import {
  attachInlineImages,
  disposeInlineImages,
  primeTerminalInlineImageAddon,
  resetTerminalInlineImageAddonForTests,
  TERMINAL_INLINE_IMAGE_OPTIONS
} from './terminal-inline-image-addon'
import { toPublicPane } from './pane-public-view'

const imageMock = vi.hoisted(() => ({
  dispose: vi.fn(),
  constructed: [] as unknown[]
}))

vi.mock('@xterm/addon-image', () => ({
  ImageAddon: vi.fn().mockImplementation(function ImageAddon(options: unknown) {
    imageMock.constructed.push(options)
    return { dispose: imageMock.dispose }
  })
}))

function createPane(): ManagedPaneInternal {
  return {
    id: 7,
    terminal: { loadAddon: vi.fn() } as never,
    imageAddon: null
  } as never
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('terminal inline image addon', () => {
  beforeEach(() => {
    resetTerminalInlineImageAddonForTests()
    imageMock.dispose.mockClear()
    imageMock.constructed.length = 0
  })

  it('loads the addon once the chunk resolves and reuses it for later panes', async () => {
    const first = createPane()
    attachInlineImages(first)
    expect(first.imageAddon).toBeNull()

    await flushMicrotasks()
    expect(first.imageAddon).not.toBeNull()
    expect(first.terminal.loadAddon).toHaveBeenCalledWith(first.imageAddon)
    expect(imageMock.constructed[0]).toEqual(TERMINAL_INLINE_IMAGE_OPTIONS)

    // Why: after the first resolve the constructor is memoised, so the next
    // pane must attach synchronously — no frame without image parsing.
    const second = createPane()
    attachInlineImages(second)
    expect(second.imageAddon).not.toBeNull()
    expect(imageMock.constructed).toHaveLength(2)
  })

  // Why: the addon is a parser hook — output parsed before it attaches loses
  // its images for good — so the boot-time prime must make even the *first*
  // pane attach synchronously inside openTerminal.
  it('attaches the first pane synchronously once the boot prime has resolved', async () => {
    await primeTerminalInlineImageAddon()
    const pane = createPane()
    attachInlineImages(pane)
    expect(pane.imageAddon).not.toBeNull()
    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(1)
  })

  it('lets a retained public pane view observe the addon after a lazy attach', async () => {
    const pane = createPane()
    const view = toPublicPane(pane)
    expect(view.imageAddon).toBeNull()
    attachInlineImages(pane)
    await flushMicrotasks()
    expect(view.imageAddon).toBe(pane.imageAddon)
    disposeInlineImages(pane)
    expect(view.imageAddon).toBeNull()
  })

  it('does not attach to a pane disposed while the chunk was loading', async () => {
    const pane = createPane()
    attachInlineImages(pane)
    disposeInlineImages(pane)

    await flushMicrotasks()
    expect(pane.imageAddon).toBeNull()
    expect(pane.terminal.loadAddon).not.toHaveBeenCalled()
  })

  it('disposes the addon and clears the pane reference', async () => {
    const pane = createPane()
    attachInlineImages(pane)
    await flushMicrotasks()

    disposeInlineImages(pane)
    expect(imageMock.dispose).toHaveBeenCalledTimes(1)
    expect(pane.imageAddon).toBeNull()
  })

  it('is idempotent for a pane that already has the addon', async () => {
    const pane = createPane()
    attachInlineImages(pane)
    await flushMicrotasks()
    attachInlineImages(pane)
    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(1)
  })

  it('leaves the pane without images and allows a retry when the chunk fails to load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Why a fresh module instance: the loader memoises the constructor, so the
    // failure path needs its own copy that has never resolved the chunk.
    vi.resetModules()
    vi.doMock('@xterm/addon-image', () => {
      throw new Error('chunk missing')
    })
    const loader = await import('./terminal-inline-image-addon')
    const pane = createPane()
    loader.attachInlineImages(pane)
    await flushMicrotasks()

    expect(pane.imageAddon).toBeNull()
    expect(pane.terminal.loadAddon).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('inline image addon failed to load'),
      expect.anything()
    )

    // Why: the failed promise must not be memoised, otherwise every later pane
    // in the session silently loses images after one transient failure.
    vi.doUnmock('@xterm/addon-image')
    vi.resetModules()
    expect(await loader.primeTerminalInlineImageAddon()).not.toBeNull()
    warn.mockRestore()
  })
})

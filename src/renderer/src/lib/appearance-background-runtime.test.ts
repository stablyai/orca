// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { OrcaBackgroundSettings } from '../../../shared/orca-background-settings'
import { composeActiveTerminalTheme } from '../components/terminal-pane/terminal-appearance'
import {
  AppearanceBackgroundRuntime,
  getTerminalAppearanceBackgroundRevision,
  isTerminalAppearanceBackgroundActive,
  markAppearanceBackgroundArea
} from './appearance-background-runtime'
import { createBackgroundImageObjectUrlApi } from './background-image-object-url'

type ImageResult = { ok: true; data: Uint8Array; mimeType: string }

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function settingsWith(
  overrides: Partial<OrcaBackgroundSettings> = {}
): Partial<OrcaBackgroundSettings> {
  return overrides
}

describe('AppearanceBackgroundRuntime', () => {
  const runtimes: AppearanceBackgroundRuntime[] = []
  const createObjectURL = vi.fn(() => 'blob:background')
  const revokeObjectURL = vi.fn()
  const decodeImage = vi.fn<(_: string) => Promise<void>>()
  const loadImage = vi.fn()

  function createRuntime(
    imageApi: { loadImage: typeof loadImage } | null = { loadImage }
  ): AppearanceBackgroundRuntime {
    const runtime = new AppearanceBackgroundRuntime(document.documentElement, {
      imageApi,
      backgroundObjectUrls: createBackgroundImageObjectUrlApi({
        objectUrls: { createObjectURL, revokeObjectURL },
        decodeImage
      })
    })
    runtimes.push(runtime)
    return runtime
  }

  beforeEach(() => {
    loadImage.mockReset()
    createObjectURL.mockReset().mockReturnValue('blob:background')
    revokeObjectURL.mockReset()
    decodeImage.mockReset().mockResolvedValue()
  })

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) {
      runtime.dispose()
    }
  })

  it('loads independent areas and publishes their image and effect variables', async () => {
    loadImage.mockImplementation((name: string) =>
      Promise.resolve({ ok: true, data: new Uint8Array([name.length]), mimeType: 'image/png' })
    )
    createObjectURL
      .mockReturnValueOnce('blob:terminal')
      .mockReturnValueOnce('blob:left')
      .mockReturnValueOnce('blob:right')
    const runtime = createRuntime()

    runtime.apply(
      settingsWith({
        orcaBackgroundByArea: {
          terminal: 'terminal.png',
          leftSidebar: 'left.png',
          rightSidebar: 'right.png'
        },
        orcaBackgroundAreas: { terminal: true, leftSidebar: true, rightSidebar: true },
        orcaBackgroundOpacityByArea: { leftSidebar: 0.2, rightSidebar: 0.8 },
        orcaBackgroundBlurByArea: { terminal: 5, rightSidebar: 20 },
        orcaBackgroundFit: 'contain'
      })
    )

    await vi.waitFor(() =>
      expect(document.documentElement.getAttribute('data-orca-background-areas')).toBe(
        'terminal left-sidebar right-sidebar'
      )
    )
    const style = document.documentElement.style
    expect(style.getPropertyValue('--orca-background-terminal-image')).toContain('blob:terminal')
    expect(style.getPropertyValue('--orca-background-left-sidebar-image')).toContain('blob:left')
    expect(style.getPropertyValue('--orca-background-right-sidebar-image')).toContain('blob:right')
    expect(style.getPropertyValue('--orca-background-left-sidebar-opacity')).toBe('0.2')
    expect(style.getPropertyValue('--orca-background-right-sidebar-blur')).toBe('20px')
    expect(style.getPropertyValue('--orca-background-size')).toBe('contain')
    expect(loadImage).toHaveBeenCalledTimes(3)
  })

  it('shares one object URL between areas and keeps it for effect-only updates', async () => {
    loadImage.mockResolvedValue({
      ok: true,
      data: new Uint8Array([1]),
      mimeType: 'image/png'
    })
    const runtime = createRuntime()
    const images = { terminal: 'same.png', leftSidebar: 'same.png' }

    runtime.apply(
      settingsWith({
        orcaBackgroundByArea: images,
        orcaBackgroundAreas: { terminal: true, leftSidebar: true, rightSidebar: false }
      })
    )
    await vi.waitFor(() =>
      expect(document.documentElement.getAttribute('data-orca-background-areas')).toContain(
        'left-sidebar'
      )
    )

    runtime.apply(
      settingsWith({
        orcaBackgroundByArea: images,
        orcaBackgroundAreas: { terminal: true, leftSidebar: true, rightSidebar: false },
        orcaBackgroundOpacityByArea: { terminal: 0.7 }
      })
    )

    expect(loadImage).toHaveBeenCalledOnce()
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(
      document.documentElement.style.getPropertyValue('--orca-background-terminal-opacity')
    ).toBe('0.7')
  })

  it('discards and revokes a stale load after the selected image changes', async () => {
    const first = deferred<ImageResult>()
    const second = deferred<ImageResult>()
    loadImage.mockImplementation((name: string) =>
      name === 'first.png' ? first.promise : second.promise
    )
    createObjectURL.mockReturnValueOnce('blob:second').mockReturnValueOnce('blob:first')
    const runtime = createRuntime()

    runtime.apply(
      settingsWith({
        orcaBackgroundByArea: { leftSidebar: 'first.png' },
        orcaBackgroundAreas: { terminal: false, leftSidebar: true, rightSidebar: false }
      })
    )
    runtime.apply(
      settingsWith({
        orcaBackgroundByArea: { leftSidebar: 'second.png' },
        orcaBackgroundAreas: { terminal: false, leftSidebar: true, rightSidebar: false }
      })
    )

    second.resolve({ ok: true, data: new Uint8Array([2]), mimeType: 'image/png' })
    await vi.waitFor(() =>
      expect(
        document.documentElement.style.getPropertyValue('--orca-background-left-sidebar-image')
      ).toContain('blob:second')
    )
    first.resolve({ ok: true, data: new Uint8Array([1]), mimeType: 'image/png' })
    await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:first'))

    expect(
      document.documentElement.style.getPropertyValue('--orca-background-left-sidebar-image')
    ).toContain('blob:second')
  })

  it('keeps xterm opaque until the terminal image loads successfully', async () => {
    const image = deferred<ImageResult>()
    const replacement = deferred<ImageResult>()
    const decode = deferred<void>()
    loadImage.mockImplementation((name: string) =>
      name === 'terminal.png' ? image.promise : replacement.promise
    )
    decodeImage.mockReturnValueOnce(decode.promise)
    const runtime = createRuntime()
    const settings = settingsWith({
      orcaBackgroundByArea: { terminal: 'terminal.png' },
      orcaBackgroundAreas: { terminal: true, leftSidebar: false, rightSidebar: false }
    })

    runtime.apply(settings)
    const pendingRevision = getTerminalAppearanceBackgroundRevision()
    expect(isTerminalAppearanceBackgroundActive(settings)).toBe(false)
    expect(
      composeActiveTerminalTheme(
        { background: '#112233' },
        settings as GlobalSettings,
        isTerminalAppearanceBackgroundActive(settings)
      )?.background
    ).toBe('#112233')

    image.resolve({ ok: true, data: new Uint8Array([1]), mimeType: 'image/png' })
    await vi.waitFor(() => expect(decodeImage).toHaveBeenCalledWith('blob:background'))
    expect(isTerminalAppearanceBackgroundActive(settings)).toBe(false)
    decode.resolve(undefined)
    await vi.waitFor(() => expect(isTerminalAppearanceBackgroundActive(settings)).toBe(true))
    expect(getTerminalAppearanceBackgroundRevision()).toBeGreaterThan(pendingRevision)
    expect(
      composeActiveTerminalTheme(
        { background: '#112233' },
        settings as GlobalSettings,
        isTerminalAppearanceBackgroundActive(settings)
      )?.background
    ).toBe('rgba(17, 34, 51, 0)')

    const replacementSettings = settingsWith({
      orcaBackgroundByArea: { terminal: 'replacement.png' },
      orcaBackgroundAreas: { terminal: true, leftSidebar: false, rightSidebar: false }
    })
    runtime.apply(replacementSettings)
    expect(isTerminalAppearanceBackgroundActive(replacementSettings)).toBe(false)
    replacement.resolve({ ok: true, data: new Uint8Array([2]), mimeType: 'image/png' })
    await vi.waitFor(() =>
      expect(isTerminalAppearanceBackgroundActive(replacementSettings)).toBe(true)
    )
  })

  it('keeps the area and xterm inactive when image loading fails', async () => {
    loadImage.mockResolvedValue({ ok: false, reason: 'not-found' })
    const runtime = createRuntime()
    const settings = settingsWith({
      orcaBackgroundImage: 'missing.png',
      orcaBackgroundAreas: { terminal: true, leftSidebar: false, rightSidebar: false }
    })

    runtime.apply(settings)
    await vi.waitFor(() => expect(loadImage).toHaveBeenCalledOnce())

    expect(document.documentElement.hasAttribute('data-orca-background-areas')).toBe(false)
    expect(isTerminalAppearanceBackgroundActive(settings)).toBe(false)
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('revokes a decoded URL candidate and keeps the area inactive when decode fails', async () => {
    loadImage.mockResolvedValue({
      ok: true,
      data: new Uint8Array([1]),
      mimeType: 'image/png'
    })
    decodeImage.mockRejectedValue(new Error('decode failed'))
    const runtime = createRuntime()
    const settings = settingsWith({
      orcaBackgroundImage: 'corrupt.png',
      orcaBackgroundAreas: { terminal: true, leftSidebar: false, rightSidebar: false }
    })

    runtime.apply(settings)
    await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:background'))

    expect(document.documentElement.hasAttribute('data-orca-background-areas')).toBe(false)
    expect(isTerminalAppearanceBackgroundActive(settings)).toBe(false)
  })

  it('degrades without an image API and clears styles and URLs on disposal', async () => {
    const unavailable = createRuntime(null)
    const settings = settingsWith({
      orcaBackgroundImage: 'terminal.png',
      orcaBackgroundAreas: { terminal: true, leftSidebar: false, rightSidebar: false }
    })
    unavailable.apply(settings)
    expect(document.documentElement.hasAttribute('data-orca-background-areas')).toBe(false)
    expect(isTerminalAppearanceBackgroundActive(settings)).toBe(false)

    loadImage.mockResolvedValue({
      ok: true,
      data: new Uint8Array([1]),
      mimeType: 'image/png'
    })
    const available = createRuntime()
    available.apply(settings)
    await vi.waitFor(() => expect(isTerminalAppearanceBackgroundActive(settings)).toBe(true))
    available.dispose()

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:background')
    expect(document.documentElement.hasAttribute('data-orca-background-areas')).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--orca-background-size')).toBe('')
    expect(isTerminalAppearanceBackgroundActive(settings)).toBe(false)
  })

  it('marks static area roots without overriding positioned roots', () => {
    const staticRoot = document.createElement('div')
    const positionedRoot = document.createElement('div')
    positionedRoot.style.position = 'absolute'
    document.body.append(staticRoot, positionedRoot)

    markAppearanceBackgroundArea(staticRoot, 'terminal')
    markAppearanceBackgroundArea(positionedRoot, 'terminal')

    expect(staticRoot.getAttribute('data-orca-background-area')).toBe('terminal')
    expect(staticRoot.hasAttribute('data-orca-background-relative')).toBe(true)
    expect(positionedRoot.hasAttribute('data-orca-background-relative')).toBe(false)
    staticRoot.remove()
    positionedRoot.remove()
  })
})

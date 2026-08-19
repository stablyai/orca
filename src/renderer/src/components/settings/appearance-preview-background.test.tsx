// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../../shared/constants'
import { createBackgroundImageObjectUrlApi } from '../../lib/background-image-object-url'
import {
  createAppearancePreviewBackgroundObjectUrl,
  getAppearancePreviewBackgroundStyle,
  resolveAppearancePreviewBackground,
  useAppearancePreviewBackground
} from './appearance-preview-background'

type BackgroundOverrides = {
  orcaBackgroundImage?: string | null
  orcaBackgroundByArea?: Partial<Record<'terminal' | 'leftSidebar' | 'rightSidebar', string | null>>
  orcaBackgroundOpacity?: number
  orcaBackgroundOpacityByArea?: Partial<
    Record<'terminal' | 'leftSidebar' | 'rightSidebar', unknown>
  >
  orcaBackgroundBlur?: number
  orcaBackgroundBlurByArea?: Partial<Record<'terminal' | 'leftSidebar' | 'rightSidebar', unknown>>
  orcaBackgroundFit?: string
  orcaBackgroundAreas?: { terminal?: boolean; leftSidebar?: boolean; rightSidebar?: boolean }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function makeSettings(overrides: BackgroundOverrides = {}): GlobalSettings {
  return { ...getDefaultSettings('/tmp'), ...overrides } as GlobalSettings
}

describe('appearance preview background', () => {
  const createObjectURL = vi.fn(() => 'blob:preview-background')
  const revokeObjectURL = vi.fn()
  const decodeImage = vi.fn<(_: string) => Promise<void>>()
  const loadImage = vi.fn()
  const imageApi = { loadImage }
  const backgroundObjectUrls = createBackgroundImageObjectUrlApi({
    objectUrls: { createObjectURL, revokeObjectURL },
    decodeImage
  })
  const dependencies = { imageApi, backgroundObjectUrls }

  beforeEach(() => {
    createObjectURL.mockReset().mockReturnValue('blob:preview-background')
    revokeObjectURL.mockReset()
    decodeImage.mockReset().mockResolvedValue()
    loadImage.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('preserves legacy defaults, clamps appearance, and gates each area independently', () => {
    expect(resolveAppearancePreviewBackground(makeSettings(), 'terminal')).toBeNull()
    const settings = makeSettings({
      orcaBackgroundImage: 'ocean.png',
      orcaBackgroundOpacity: 3,
      orcaBackgroundBlur: -2,
      orcaBackgroundFit: 'tile',
      orcaBackgroundAreas: { terminal: true, leftSidebar: true, rightSidebar: false }
    })

    expect(resolveAppearancePreviewBackground(settings, 'terminal')).toEqual({
      area: 'terminal',
      fileName: 'ocean.png',
      opacity: 1,
      blurPx: 0,
      fit: 'tile'
    })
    expect(resolveAppearancePreviewBackground(settings, 'leftSidebar')).toMatchObject({
      area: 'leftSidebar',
      fileName: 'ocean.png'
    })
    expect(resolveAppearancePreviewBackground(settings, 'rightSidebar')).toBeNull()
    expect(
      resolveAppearancePreviewBackground(
        makeSettings({ orcaBackgroundImage: 'ocean.png', orcaBackgroundFit: 'toString' }),
        'terminal'
      )
    ).toMatchObject({ fit: 'cover' })
  })

  it('resolves distinct images, partial legacy fallback, and explicit per-area clearing', () => {
    const distinct = makeSettings({
      orcaBackgroundImage: 'legacy.png',
      orcaBackgroundByArea: {
        terminal: 'terminal.png',
        leftSidebar: 'left.png',
        rightSidebar: 'right.png'
      },
      orcaBackgroundAreas: { terminal: true, leftSidebar: true, rightSidebar: true }
    })

    expect(resolveAppearancePreviewBackground(distinct, 'terminal')?.fileName).toBe('terminal.png')
    expect(resolveAppearancePreviewBackground(distinct, 'leftSidebar')?.fileName).toBe('left.png')
    expect(resolveAppearancePreviewBackground(distinct, 'rightSidebar')?.fileName).toBe('right.png')

    const partial = makeSettings({
      orcaBackgroundImage: 'legacy.png',
      orcaBackgroundByArea: { terminal: 'terminal.png', leftSidebar: null },
      orcaBackgroundAreas: { terminal: true, leftSidebar: true, rightSidebar: true }
    })
    expect(resolveAppearancePreviewBackground(partial, 'terminal')?.fileName).toBe('terminal.png')
    expect(resolveAppearancePreviewBackground(partial, 'leftSidebar')).toBeNull()
    expect(resolveAppearancePreviewBackground(partial, 'rightSidebar')?.fileName).toBe('legacy.png')
  })

  it('maps blur, opacity, and fit to the live background treatment', () => {
    expect(
      getAppearancePreviewBackgroundStyle({
        area: 'rightSidebar',
        fileName: 'ocean.png',
        objectUrl: 'blob:ocean',
        opacity: 0.42,
        blurPx: 10,
        fit: 'stretch'
      })
    ).toEqual({
      backgroundImage: 'url("blob:ocean")',
      backgroundPosition: 'center center',
      backgroundSize: '100% 100%',
      backgroundRepeat: 'no-repeat',
      opacity: 0.42,
      filter: 'blur(10px)',
      transform: 'scale(1.4)',
      transformOrigin: 'center center'
    })
  })

  it('resolves opacity and blur independently with shared fallback', () => {
    const settings = makeSettings({
      orcaBackgroundImage: 'ocean.png',
      orcaBackgroundAreas: { terminal: true, leftSidebar: true, rightSidebar: true },
      orcaBackgroundOpacity: 0.49,
      orcaBackgroundOpacityByArea: { terminal: 0, leftSidebar: 2, rightSidebar: null },
      orcaBackgroundBlur: 4,
      orcaBackgroundBlurByArea: { terminal: 8, leftSidebar: -2, rightSidebar: Infinity }
    })

    expect(resolveAppearancePreviewBackground(settings, 'terminal')).toMatchObject({
      opacity: 0,
      blurPx: 8
    })
    expect(resolveAppearancePreviewBackground(settings, 'leftSidebar')).toMatchObject({
      opacity: 1,
      blurPx: 0
    })
    expect(resolveAppearancePreviewBackground(settings, 'rightSidebar')).toMatchObject({
      opacity: 0.49,
      blurPx: 4
    })
  })

  it('returns an object URL only after the background bytes decode', async () => {
    const decode = deferred<void>()
    decodeImage.mockReturnValue(decode.promise)
    loadImage.mockResolvedValue({
      ok: true,
      data: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png'
    })

    const pending = createAppearancePreviewBackgroundObjectUrl(
      'ocean.png',
      imageApi,
      backgroundObjectUrls
    )

    await waitFor(() => expect(decodeImage).toHaveBeenCalledWith('blob:preview-background'))
    decode.resolve(undefined)
    await expect(pending).resolves.toBe('blob:preview-background')

    expect(loadImage).toHaveBeenCalledWith('ocean.png')
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
  })

  it('updates appearance without reloading bytes and revokes the URL when disabled', async () => {
    loadImage.mockResolvedValue({
      ok: true,
      data: new Uint8Array([1]),
      mimeType: 'image/png'
    })
    const initial = makeSettings({
      orcaBackgroundByArea: { terminal: 'ocean.png' },
      orcaBackgroundOpacity: 0.2,
      orcaBackgroundBlur: 4,
      orcaBackgroundFit: 'cover'
    })
    const { result, rerender } = renderHook(
      ({ settings }: { settings: GlobalSettings }) =>
        useAppearancePreviewBackground(settings, 'terminal', dependencies),
      { initialProps: { settings: initial } }
    )

    await waitFor(() => expect(result.current?.objectUrl).toBe('blob:preview-background'))

    rerender({
      settings: makeSettings({
        orcaBackgroundByArea: { terminal: 'ocean.png' },
        orcaBackgroundOpacity: 0.2,
        orcaBackgroundOpacityByArea: { terminal: 0.65 },
        orcaBackgroundBlur: 4,
        orcaBackgroundBlurByArea: { terminal: 18 },
        orcaBackgroundFit: 'contain'
      })
    })

    expect(result.current).toMatchObject({ opacity: 0.65, blurPx: 18, fit: 'contain' })
    expect(loadImage).toHaveBeenCalledOnce()

    rerender({
      settings: makeSettings({
        orcaBackgroundByArea: { terminal: 'ocean.png' },
        orcaBackgroundAreas: { terminal: false }
      })
    })

    await waitFor(() => expect(result.current).toBeNull())
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-background')
  })

  it('keeps one failed area empty without throwing', async () => {
    loadImage.mockResolvedValue({ ok: false, reason: 'read-failed' })
    const { result } = renderHook(() =>
      useAppearancePreviewBackground(
        makeSettings({
          orcaBackgroundByArea: { leftSidebar: 'missing.png' },
          orcaBackgroundAreas: { leftSidebar: true }
        }),
        'leftSidebar',
        dependencies
      )
    )

    await waitFor(() => expect(loadImage).toHaveBeenCalledOnce())

    expect(result.current).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('never combines the next file settings with the previous image URL', async () => {
    const firstLoad = deferred<{
      ok: true
      data: Uint8Array
      mimeType: string
    }>()
    const secondLoad = deferred<{
      ok: true
      data: Uint8Array
      mimeType: string
    }>()
    loadImage.mockImplementation((fileName: string) =>
      fileName === 'first.png' ? firstLoad.promise : secondLoad.promise
    )
    createObjectURL.mockReturnValueOnce('blob:second').mockReturnValueOnce('blob:first')

    const { result, rerender } = renderHook(
      ({ settings }: { settings: GlobalSettings }) =>
        useAppearancePreviewBackground(settings, 'leftSidebar', dependencies),
      {
        initialProps: {
          settings: makeSettings({
            orcaBackgroundByArea: { leftSidebar: 'first.png' },
            orcaBackgroundAreas: { leftSidebar: true },
            orcaBackgroundOpacity: 0.2
          })
        }
      }
    )

    rerender({
      settings: makeSettings({
        orcaBackgroundByArea: { leftSidebar: 'second.png' },
        orcaBackgroundAreas: { leftSidebar: true },
        orcaBackgroundOpacity: 0.8
      })
    })
    expect(result.current).toBeNull()

    await act(async () => {
      secondLoad.resolve({ ok: true, data: new Uint8Array([2]), mimeType: 'image/png' })
      await secondLoad.promise
    })
    await waitFor(() =>
      expect(result.current).toMatchObject({
        fileName: 'second.png',
        objectUrl: 'blob:second',
        opacity: 0.8
      })
    )

    await act(async () => {
      firstLoad.resolve({ ok: true, data: new Uint8Array([1]), mimeType: 'image/png' })
      await firstLoad.promise
    })
    expect(result.current).toMatchObject({ fileName: 'second.png', objectUrl: 'blob:second' })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:first')
  })
})

// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { usePaneTitleBackground } from './use-pane-title-background'

const IMAGE_ID = '33333333-2222-4222-8222-222222222222.png'
const OPAQUE_WHITE = 'rgb(255 255 255)'
const TRANSLUCENT_WHITE = 'color-mix(in srgb, #ffffff 60%, transparent)'

const settings = {
  ...getDefaultSettings('/tmp'),
  terminalBackgroundOpacity: 0.6,
  appBackgroundImageId: IMAGE_ID
}

function stubImageRead(read: ReturnType<typeof vi.fn>): void {
  // Why Reflect: the test only supplies the one preload method the blob cache calls.
  Reflect.set(window, 'api', { appBackground: { read } })
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:pane-title-test', revokeObjectURL: vi.fn() })
}

function renderTitleBackground(input: Parameters<typeof usePaneTitleBackground>[0]['settings']) {
  return renderHook(() =>
    usePaneTitleBackground({
      settings: input,
      terminalBackground: '#ffffff',
      appSurface: 'light',
      titleUsesLightSurface: true
    })
  )
}

describe('usePaneTitleBackground', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(window, 'api')
  })

  it('turns translucent once the background image has loaded', async () => {
    stubImageRead(vi.fn().mockResolvedValue(new ArrayBuffer(4)))
    const { result } = renderTitleBackground(settings)

    await waitFor(() => expect(result.current).toBe(TRANSLUCENT_WHITE))
  })

  it('stays opaque when the applied image file is missing', async () => {
    const read = vi.fn().mockResolvedValue(null)
    stubImageRead(read)
    const { result } = renderTitleBackground({
      ...settings,
      appBackgroundImageId: '44444444-2222-4222-8222-222222222222.png'
    })

    await waitFor(() => expect(read).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(result.current).toBe(OPAQUE_WHITE)
  })

  it('stays opaque without a background image', () => {
    const { result } = renderTitleBackground({ ...settings, appBackgroundImageId: null })

    expect(result.current).toBe(OPAQUE_WHITE)
  })
})

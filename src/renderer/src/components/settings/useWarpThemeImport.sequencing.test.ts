import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { WarpThemeImportPreview } from '../../../../shared/terminal-custom-themes'

const mockStateValues: unknown[] = []
let mockStateIndex = 0
const mockRefValues: { current: unknown }[] = []
let mockRefIndex = 0

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

function resetMockHooks() {
  mockStateIndex = 0
  mockRefIndex = 0
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function createPreview(sourceLabel: string): WarpThemeImportPreview {
  return { found: false, sourceLabel, themes: [], skippedFiles: [] }
}

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      void effect()
    },
    useRef: (initial: unknown) => {
      const i = mockRefIndex++
      mockRefValues[i] ??= { current: initial }
      return mockRefValues[i]
    },
    useState: (initial: unknown) => {
      const i = mockStateIndex++
      if (mockStateValues[i] === undefined) {
        mockStateValues[i] = typeof initial === 'function' ? initial() : initial
      }
      const setter = (value: unknown) => {
        mockStateValues[i] = typeof value === 'function' ? value(mockStateValues[i]) : value
      }
      return [mockStateValues[i], setter]
    }
  }
})

import { useWarpThemeImport } from './useWarpThemeImport'

const baseSettings = { terminalCustomThemes: [] } as unknown as GlobalSettings

describe('useWarpThemeImport request sequencing', () => {
  beforeEach(() => {
    mockStateValues.length = 0
    mockRefValues.length = 0
    resetMockHooks()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('keeps the newest preview when responses resolve out of order', async () => {
    const first = createDeferred<WarpThemeImportPreview>()
    const second = createDeferred<WarpThemeImportPreview>()
    const previewMock = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    vi.stubGlobal('window', {
      api: { settings: { previewWarpThemeImport: previewMock } }
    })

    let warp = useWarpThemeImport(vi.fn(), baseSettings)
    const firstRequest = warp.handlePreviewSource({ kind: 'auto' })
    const secondRequest = warp.handlePreviewSource({ kind: 'chooseFile' })

    second.resolve(createPreview('current'))
    await secondRequest
    first.resolve(createPreview('stale'))
    await firstRequest

    resetMockHooks()
    warp = useWarpThemeImport(vi.fn(), baseSettings)
    expect(warp.preview?.sourceLabel).toBe('current')
    expect(warp.loading).toBe(false)
  })

  it('ignores a closed preview while a reopened import is pending', async () => {
    const first = createDeferred<WarpThemeImportPreview>()
    const second = createDeferred<WarpThemeImportPreview>()
    const previewMock = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    vi.stubGlobal('window', {
      api: { settings: { previewWarpThemeImport: previewMock } }
    })

    let warp = useWarpThemeImport(vi.fn(), baseSettings)
    const firstRequest = warp.handleClick()
    warp.handleOpenChange(false)
    resetMockHooks()
    warp = useWarpThemeImport(vi.fn(), baseSettings)
    const secondRequest = warp.handleImportYamlClick()

    first.resolve(createPreview('stale'))
    await firstRequest
    resetMockHooks()
    warp = useWarpThemeImport(vi.fn(), baseSettings)
    expect(warp.open).toBe(false)
    expect(warp.preview).toBeNull()
    expect(warp.loading).toBe(true)

    second.resolve(createPreview('current'))
    await secondRequest
    resetMockHooks()
    warp = useWarpThemeImport(vi.fn(), baseSettings)
    expect(warp.open).toBe(true)
    expect(warp.preview?.sourceLabel).toBe('current')
    expect(warp.loading).toBe(false)
  })
})

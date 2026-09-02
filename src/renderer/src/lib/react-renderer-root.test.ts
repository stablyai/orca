import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { getOrCreateRendererRoot } from './react-renderer-root'

vi.mock('react-dom/client', () => ({
  createRoot: vi.fn()
}))

beforeEach(() => {
  vi.mocked(createRoot).mockReset()
})

describe('getOrCreateRendererRoot', () => {
  it('reuses the root retained by an HMR entry module', () => {
    const hotData: { orcaRendererRoot?: Root } = {}
    const root = { render: vi.fn(), unmount: vi.fn() } as unknown as Root
    vi.mocked(createRoot).mockReturnValue(root)

    expect(getOrCreateRendererRoot({} as HTMLElement, hotData)).toBe(root)
    expect(getOrCreateRendererRoot({} as HTMLElement, hotData)).toBe(root)
    expect(createRoot).toHaveBeenCalledTimes(1)
  })

  it('creates an independent root without HMR state', () => {
    const first = { render: vi.fn(), unmount: vi.fn() } as unknown as Root
    const second = { render: vi.fn(), unmount: vi.fn() } as unknown as Root
    vi.mocked(createRoot).mockReturnValueOnce(first).mockReturnValueOnce(second)

    expect(getOrCreateRendererRoot({} as HTMLElement)).toBe(first)
    expect(getOrCreateRendererRoot({} as HTMLElement)).toBe(second)
  })
})

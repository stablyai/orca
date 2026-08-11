// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { statusMock, storeState } = vi.hoisted(() => ({
  statusMock: vi.fn(),
  storeState: { settings: {} as { previewProxy?: { enabled: boolean } } }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

import { usePreviewProxyActive } from './use-preview-proxy-active'

function Probe(): React.JSX.Element {
  return <span>{usePreviewProxyActive() ? 'active' : 'inactive'}</span>
}

describe('usePreviewProxyActive', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    storeState.settings = {}
    statusMock.mockReset()
    statusMock.mockResolvedValue(null)
    ;(window as unknown as { api: unknown }).api = { previewProxy: { status: statusMock } }
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  async function render(): Promise<void> {
    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
  }

  it('answers from settings without waiting for the status probe', async () => {
    storeState.settings = { previewProxy: { enabled: true } }
    statusMock.mockImplementation(() => new Promise(() => {}))

    await render()

    expect(container.textContent).toBe('active')
  })

  it('reports a flags-driven proxy that never touched settings', async () => {
    statusMock.mockResolvedValue({ running: true, source: 'flags' })

    await render()

    expect(container.textContent).toBe('active')
  })

  it('stays inactive when nothing is serving', async () => {
    statusMock.mockResolvedValue({ running: false, source: null })

    await render()

    expect(container.textContent).toBe('inactive')
  })

  it('survives a runtime whose preload predates the preview proxy', async () => {
    ;(window as unknown as { api: unknown }).api = {}

    await render()

    expect(container.textContent).toBe('inactive')
  })
})

// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useEmulatorPaneZoom } from './emulator-pane-zoom'

describe('useEmulatorPaneZoom', () => {
  it('keeps zoom across stream metrics updates and resets only for a new device', () => {
    const view = renderHook(({ deviceId }) => useEmulatorPaneZoom(deviceId), {
      initialProps: { deviceId: 'phone-1' }
    })
    const metrics = { fitScale: 0.4, fitDisplayScale: 0.3 }

    act(() => view.result.current.setMetrics(metrics))
    act(() => view.result.current.zoom('in'))
    expect(view.result.current).toMatchObject({
      state: { mode: 'fixed', scale: 0.5 },
      percentage: 50
    })

    act(() => view.result.current.setMetrics({ ...metrics }))
    expect(view.result.current.state).toEqual({ mode: 'fixed', scale: 0.5 })

    view.rerender({ deviceId: 'phone-2' })
    expect(view.result.current).toMatchObject({
      state: { mode: 'fit' },
      percentage: 100,
      availability: { in: false, out: false, actual: false, fit: false, 'fit-display': false }
    })
  })
})

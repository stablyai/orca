// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useMarkupMode } from './useMarkupMode'

const captured = vi.hoisted(() => ({ count: 0 }))
vi.mock('./markup-base-image', () => ({
  captureMarkupBaseImage: async () => {
    captured.count += 1
    return { dataUrl: 'data:image/png;base64,', width: 1, height: 1 }
  }
}))

it('captures only after prepare succeeds, and never for a Draw cancelled or failed while preparing', async () => {
  const { result } = renderHook(() =>
    useMarkupMode({
      getCaptureContext: () => ({
        source: { kind: 'image', element: document.createElement('img') },
        cssWidth: 1,
        cssHeight: 1,
        outputScale: 1
      }),
      onDeliver: () => {}
    })
  )

  let finishPrepare: (ok: boolean) => void = () => {}
  let started!: Promise<void>
  act(() => {
    started = result.current.start(() => new Promise((resolve) => (finishPrepare = resolve)))
  })
  expect(result.current.state).toBe('capturing')
  act(() => result.current.cancel())
  await act(async () => {
    finishPrepare(true)
    await started
  })
  expect(captured.count).toBe(0)
  expect(result.current.state).toBe('idle')

  await act(() => result.current.start(async () => false))
  expect(captured.count).toBe(0)
  expect(result.current.state).toBe('idle')

  await act(() => result.current.start(async () => true))
  expect(captured.count).toBe(1)
  expect(result.current.state).toBe('drawing')
})

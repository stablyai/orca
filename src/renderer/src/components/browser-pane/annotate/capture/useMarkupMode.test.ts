// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useMarkupMode, type MarkupCaptureContext } from './useMarkupMode'
import { useMarkupStartAfterPicker } from './use-markup-start-after-picker'
import type { GrabModeHook } from '../grab/useGrabMode'

const captured = vi.hoisted(() => ({ count: 0 }))
vi.mock('./markup-base-image', () => ({
  captureMarkupBaseImage: async () => {
    captured.count += 1
    return { dataUrl: 'data:image/png;base64,', width: 1, height: 1 }
  }
}))

const captureContext = (): MarkupCaptureContext => ({
  source: { kind: 'image', element: document.createElement('img') },
  cssWidth: 1,
  cssHeight: 1,
  outputScale: 1
})

beforeEach(() => {
  captured.count = 0
})

it('captures only after prepare succeeds, and never for a Draw cancelled or failed while preparing', async () => {
  const { result } = renderHook(() =>
    useMarkupMode({ getCaptureContext: captureContext, onDeliver: () => {} })
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

it('a Draw whose tab closes while preparing never captures', async () => {
  const { result, unmount } = renderHook(() =>
    useMarkupMode({ getCaptureContext: captureContext, onDeliver: () => {} })
  )
  let finishPrepare: (ok: boolean) => void = () => {}
  let started!: Promise<void>
  act(() => {
    started = result.current.start(() => new Promise((resolve) => (finishPrepare = resolve)))
  })
  unmount()
  finishPrepare(true)
  await started
  expect(captured.count).toBe(0)
})

it('Draw waits for a picker teardown still in flight after the picker reads idle, and aborts if it was superseded', async () => {
  let teardown: Promise<boolean> | null = null
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Draw start path reads only state and pendingTeardown.
  const grab = { state: 'idle', pendingTeardown: () => teardown } as unknown as GrabModeHook
  const { result } = renderHook(() => {
    const markup = useMarkupMode({ getCaptureContext: captureContext, onDeliver: () => {} })
    const startDraw = useMarkupStartAfterPicker({
      markup,
      grab,
      stopPicker: () => {},
      webviewRef: { current: null }
    })
    return { markup, startDraw }
  })

  let finishTeardown: (clean: boolean) => void = () => {}
  teardown = new Promise((resolve) => (finishTeardown = resolve))
  let started!: Promise<void>
  act(() => {
    started = result.current.startDraw()
  })
  await act(async () => {
    await Promise.resolve()
  })
  expect(captured.count).toBe(0)
  await act(async () => {
    finishTeardown(true)
    await started
  })
  expect(captured.count).toBe(1)

  act(() => result.current.markup.cancel())
  teardown = Promise.resolve(false)
  await act(() => result.current.startDraw())
  expect(captured.count).toBe(1)
  expect(result.current.markup.state).toBe('idle')
})

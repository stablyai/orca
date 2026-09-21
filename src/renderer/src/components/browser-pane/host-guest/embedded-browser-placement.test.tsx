// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import {
  measureEmbeddedBrowserPlacement,
  setEmbeddedBrowserPlacement,
  useEmbeddedBrowserPlacement
} from './embedded-browser-placement'

afterEach(() => {
  cleanup()
  setEmbeddedBrowserPlacement('browser-a', null)
  setEmbeddedBrowserPlacement('browser-b', null)
})

it('clips a zoomed card to the visible canvas bounds', () => {
  const element = {
    getBoundingClientRect: () => ({
      left: 80,
      top: 90,
      right: 580,
      bottom: 490,
      width: 500,
      height: 400
    })
  } as HTMLElement
  const canvas = {
    getBoundingClientRect: () => ({ left: 100, top: 120, right: 500, bottom: 450 })
  } as HTMLElement
  expect(measureEmbeddedBrowserPlacement(element, canvas, false)).toEqual({
    left: 80,
    top: 90,
    width: 500,
    height: 400,
    interactive: false,
    clipPath: 'inset(30px 80px 40px 20px)'
  })
})

it('keeps stable snapshots, isolates pages, and releases their placements', () => {
  const placement = {
    left: 10,
    top: 20,
    width: 400,
    height: 300,
    clipPath: 'inset(0px)',
    interactive: true
  }
  const { result } = renderHook(() => useEmbeddedBrowserPlacement('browser-a'))
  expect(result.current).toBeNull()
  act(() => setEmbeddedBrowserPlacement('browser-b', placement))
  expect(result.current).toBeNull()
  act(() => setEmbeddedBrowserPlacement('browser-a', placement))
  expect(result.current).toBe(placement)
  act(() => setEmbeddedBrowserPlacement('browser-a', { ...placement }))
  expect(result.current).toBe(placement)
  act(() => setEmbeddedBrowserPlacement('browser-a', null))
  expect(result.current).toBeNull()
})

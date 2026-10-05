// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { usePublishedMachineName } from './use-published-machine-name'

const getStatus = vi.fn()

beforeEach(() => {
  getStatus.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { runtime: { getStatus } }
  })
})
afterEach(() => cleanup())

it('names a saved override at once and asks the runtime only for the detected name', async () => {
  getStatus.mockResolvedValue({ machineName: 'Brennan’s MacBook Pro' })
  const view = renderHook(({ saved }) => usePublishedMachineName(saved), {
    initialProps: { saved: '' }
  })
  await act(async () => {})
  expect(view.result.current).toBe('Brennan’s MacBook Pro')
  expect(getStatus).toHaveBeenCalledTimes(1)

  // The runtime still answering with the old name must not reach the caption.
  view.rerender({ saved: ' QA Override Desk ' })
  await act(async () => {})
  expect(view.result.current).toBe('QA Override Desk')
  expect(getStatus).toHaveBeenCalledTimes(1)

  getStatus.mockResolvedValue({ machineName: 'Brennan’s MacBook Pro' })
  view.rerender({ saved: '' })
  await act(async () => {})
  expect(view.result.current).toBe('Brennan’s MacBook Pro')
  expect(getStatus).toHaveBeenCalledTimes(2)
})

it('keeps the last known detected name when a status read fails', async () => {
  getStatus.mockResolvedValue({ machineName: 'build-server' })
  const view = renderHook(({ saved }) => usePublishedMachineName(saved), {
    initialProps: { saved: '' }
  })
  await act(async () => {})
  getStatus.mockRejectedValue(new Error('runtime starting'))
  view.rerender({ saved: 'renamed' })
  await act(async () => {})
  expect(view.result.current).toBe('renamed')
  view.rerender({ saved: '' })
  await act(async () => {})
  expect(view.result.current).toBe('build-server')
})

it('stays blank when the runtime bridge is absent', () => {
  Object.defineProperty(window, 'api', { configurable: true, value: {} })
  const view = renderHook(() => usePublishedMachineName(''))
  expect(view.result.current).toBeNull()
})

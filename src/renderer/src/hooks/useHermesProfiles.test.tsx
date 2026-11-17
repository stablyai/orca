// @vitest-environment happy-dom

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { EMPTY_HERMES_PROFILES } from '../../../shared/hermes-profiles'
import { useHermesProfiles } from './useHermesProfiles'

let originalApiDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

it('drops the retained local snapshot when discovery is disabled', async () => {
  const list = vi.fn().mockResolvedValue({ profiles: ['work'], activeProfile: 'work' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { hermesProfiles: { list } }
  })

  const { result, rerender } = renderHook(({ enabled }) => useHermesProfiles(enabled), {
    initialProps: { enabled: true }
  })

  await waitFor(() => expect(result.current.profiles).toEqual(['work']))
  rerender({ enabled: false })
  expect(result.current).toEqual(EMPTY_HERMES_PROFILES)
})

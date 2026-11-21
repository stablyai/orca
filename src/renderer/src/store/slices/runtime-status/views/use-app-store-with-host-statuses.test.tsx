// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useAppStoreWithHostStatuses } from './use-app-store-with-host-statuses'

it('reads facts held outside the store on a render with no store write', () => {
  let chatProgram = 'unlearned'
  const selector = (): string => chatProgram
  const { result, rerender } = renderHook(() => useAppStoreWithHostStatuses(selector))
  expect(result.current).toBe('unlearned')

  chatProgram = 'available'
  rerender()

  expect(result.current).toBe('available')
})

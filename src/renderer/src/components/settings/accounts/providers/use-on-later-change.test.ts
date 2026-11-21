// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useOnLaterChange } from './use-on-later-change'

afterEach(cleanup)

it('re-reads when the runtime moves (removed, installed, switched), not on the first known value', () => {
  const changed = vi.fn()
  const { rerender } = renderHook<void, { key: string | null }>(
    ({ key }) => useOnLaterChange(key, changed),
    { initialProps: { key: null } }
  )
  rerender({ key: 'server:managed' })
  rerender({ key: 'server:managed' })
  expect(changed).not.toHaveBeenCalled()
  // The server removed: new chats move to agy.
  rerender({ key: 'cli:null' })
  expect(changed).toHaveBeenCalledTimes(1)
  rerender({ key: null })
  rerender({ key: 'cli:null' })
  expect(changed).toHaveBeenCalledTimes(1)
})

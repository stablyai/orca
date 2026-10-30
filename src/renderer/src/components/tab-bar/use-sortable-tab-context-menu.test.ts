// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useSortableTabContextMenu } from './use-sortable-tab-context-menu'

it('an old completion cannot close a reopened menu, including retained closing content', () => {
  const { result } = renderHook(useSortableTabContextMenu)
  act(() => result.current.onOpenChange(true))
  const oldComplete = result.current.onComplete
  const oldId = result.current.openingId
  act(() => result.current.onOpenChange(false))
  act(() => result.current.onOpenChange(true))
  expect(result.current.openingId).not.toBe(oldId)
  act(oldComplete)
  expect(result.current.open).toBe(true)
  act(result.current.onComplete)
  expect(result.current.open).toBe(false)
})

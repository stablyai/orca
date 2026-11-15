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

it('retires same-open completion and cannot affect a remounted owner', () => {
  const first = renderHook(useSortableTabContextMenu)
  act(() => first.result.current.onOpenChange(true))
  const oldComplete = first.result.current.onComplete
  act(() => first.result.current.onOpenChange(true))
  act(oldComplete)
  expect(first.result.current.open).toBe(true)
  const unmountedComplete = first.result.current.onComplete
  first.unmount()
  const next = renderHook(useSortableTabContextMenu)
  act(() => next.result.current.onOpenChange(true))
  act(unmountedComplete)
  expect(next.result.current.open).toBe(true)
  next.unmount()
})

// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useDiffSectionHeights } from './diff-section-height-cache'
import type { DiffSection } from './diff-section-types'

const section = (key: string): DiffSection => ({
  key,
  path: key,
  status: 'modified',
  originalContent: 'before',
  modifiedContent: 'after',
  loading: false,
  collapsed: false,
  dirty: false,
  diffResult: null,
  largeDiffRenderLimit: null
})
afterEach(cleanup)

it('retains live-file geometry across rekey/reorder/collapse and retires it on removal or context disposal', () => {
  const a = section('a'),
    b = section('b')
  const hook = renderHook(({ context, sections }) => useDiffSectionHeights(context, sections), {
    initialProps: { context: 'one', sections: [a, b] }
  })
  act(() => hook.result.current[1]({ 0: 20021, 1: 400 }))
  hook.rerender({ context: 'one', sections: [b, { ...a, contentGeneration: 1, collapsed: true }] })
  expect(hook.result.current[0]).toEqual({ 0: 400, 1: 20021 })
  hook.rerender({ context: 'one', sections: [a] })
  expect(hook.result.current[0]).toEqual({ 0: 20021 })
  hook.rerender({ context: 'one', sections: [a, b] })
  expect(hook.result.current[0]).toEqual({ 0: 20021 })
  const oldPublish = hook.result.current[1]
  hook.rerender({ context: 'two', sections: [a, b] })
  expect(hook.result.current[0]).toEqual({})
  act(() => oldPublish({ 0: 9000 }))
  expect(hook.result.current[0]).toEqual({})
  hook.rerender({ context: 'one', sections: [a, b] })
  act(() => oldPublish({ 0: 9000 }))
  expect(hook.result.current[0]).toEqual({})
})

it('keeps loading geometry but resolves terminal error, binary and limited rows without reviving stale text height', () => {
  const a = section('a')
  const hook = renderHook(({ value }) => useDiffSectionHeights('one', [value]), {
    initialProps: { value: a }
  })
  act(() => hook.result.current[1]({ 0: 20021 }))
  hook.rerender({ value: { ...a, loading: true, originalContent: '', modifiedContent: '' } })
  expect(hook.result.current[0]).toEqual({ 0: 20021 })
  hook.rerender({ value: { ...a, error: 'Unavailable' } })
  expect(hook.result.current[0]).toEqual({})
  hook.rerender({ value: a })
  expect(hook.result.current[0]).toEqual({})
  act(() => hook.result.current[1]({ 0: 20021 }))
  hook.rerender({
    value: {
      ...a,
      diffResult: {
        kind: 'binary',
        originalContent: '',
        modifiedContent: '',
        isImage: false,
        originalIsBinary: true,
        modifiedIsBinary: true
      }
    }
  })
  expect(hook.result.current[0]).toEqual({})
  hook.rerender({ value: { ...a, loadOnDemand: true } })
  expect(hook.result.current[0]).toEqual({})
})

it('imports the existing indexed snapshot against its actual restored sections', () => {
  const a = section('a'),
    b = section('b')
  const empty: DiffSection[] = []
  const hook = renderHook(({ sections }) => useDiffSectionHeights('one', sections), {
    initialProps: { sections: empty }
  })
  act(() => {
    hook.result.current[1]({ 0: 20021, 1: 400 }, [a, b])
    hook.rerender({ sections: [a, b] })
  })
  expect(hook.result.current[0]).toEqual({ 0: 20021, 1: 400 })
})

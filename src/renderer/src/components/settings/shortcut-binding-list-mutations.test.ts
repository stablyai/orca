import { describe, expect, it } from 'vitest'
import {
  adjustRecordingIndexAfterRemove,
  appendBinding,
  removeBindingAt,
  replaceBindingAt
} from './shortcut-binding-list-mutations'

describe('appendBinding', () => {
  it('appends to the end and returns a new array', () => {
    const list = ['Cmd+S']
    const next = appendBinding(list, 'Ctrl+S')
    expect(next).toEqual(['Cmd+S', 'Ctrl+S'])
    expect(next).not.toBe(list)
    expect(list).toEqual(['Cmd+S'])
  })

  it('handles an empty list', () => {
    expect(appendBinding([], 'Cmd+S')).toEqual(['Cmd+S'])
  })
})

describe('replaceBindingAt', () => {
  it('replaces the element at the index without changing length', () => {
    expect(replaceBindingAt(['a', 'b', 'c'], 1, 'B')).toEqual(['a', 'B', 'c'])
  })

  it('replaces the first and last elements', () => {
    expect(replaceBindingAt(['a', 'b', 'c'], 0, 'A')).toEqual(['A', 'b', 'c'])
    expect(replaceBindingAt(['a', 'b', 'c'], 2, 'C')).toEqual(['a', 'b', 'C'])
  })

  it('returns an unchanged copy for an out-of-range index', () => {
    const list = ['a', 'b']
    expect(replaceBindingAt(list, 5, 'x')).toEqual(['a', 'b'])
    expect(replaceBindingAt(list, -1, 'x')).toEqual(['a', 'b'])
    expect(replaceBindingAt(list, 5, 'x')).not.toBe(list)
  })

  it('does not mutate the original', () => {
    const list = ['a', 'b']
    replaceBindingAt(list, 0, 'A')
    expect(list).toEqual(['a', 'b'])
  })
})

describe('removeBindingAt', () => {
  it('removes the element at the index', () => {
    expect(removeBindingAt(['a', 'b', 'c'], 1)).toEqual(['a', 'c'])
  })

  it('removing the only element yields an empty array', () => {
    expect(removeBindingAt(['a'], 0)).toEqual([])
  })

  it('returns an unchanged copy for an out-of-range index', () => {
    const list = ['a', 'b']
    expect(removeBindingAt(list, 5)).toEqual(['a', 'b'])
    expect(removeBindingAt(list, -1)).toEqual(['a', 'b'])
    expect(removeBindingAt(list, 5)).not.toBe(list)
  })

  it('does not mutate the original', () => {
    const list = ['a', 'b', 'c']
    removeBindingAt(list, 0)
    expect(list).toEqual(['a', 'b', 'c'])
  })
})

describe('adjustRecordingIndexAfterRemove', () => {
  it('keeps null when nothing is recording', () => {
    expect(adjustRecordingIndexAfterRemove(null, 2)).toBeNull()
  })

  it('clears recording when the recorded row is removed', () => {
    expect(adjustRecordingIndexAfterRemove(2, 2)).toBeNull()
    expect(adjustRecordingIndexAfterRemove(0, 0)).toBeNull()
  })

  it('shifts the index down when a row above it is removed', () => {
    expect(adjustRecordingIndexAfterRemove(3, 1)).toBe(2)
  })

  it('leaves the index unchanged when a row below it is removed', () => {
    expect(adjustRecordingIndexAfterRemove(1, 3)).toBe(1)
  })
})

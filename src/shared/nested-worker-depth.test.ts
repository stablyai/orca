import { describe, expect, it } from 'vitest'
import {
  NESTED_WORKER_MAX_DEPTH_DEFAULT,
  nestedWorkerDepthExceededMessage,
  resolveNestedWorkerMaxDepth
} from './nested-worker-depth'

describe('resolveNestedWorkerMaxDepth', () => {
  it('defaults to 1 when unset', () => {
    expect(resolveNestedWorkerMaxDepth(undefined)).toBe(1)
    expect(resolveNestedWorkerMaxDepth(null)).toBe(1)
    expect(resolveNestedWorkerMaxDepth({})).toBe(1)
  })

  it('accepts whole numbers at or above 1', () => {
    expect(resolveNestedWorkerMaxDepth({ nestedWorkerMaxDepth: 1 })).toBe(1)
    expect(resolveNestedWorkerMaxDepth({ nestedWorkerMaxDepth: 3 })).toBe(3)
  })

  // A malformed setting must not become a way to get unlimited nesting, so every
  // rejected shape falls back to the default rather than disabling the cap.
  it.each([
    ['a numeric string', '2'],
    ['a boolean', true],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['null', null]
  ])('falls back to the default for %s', (_label, value) => {
    expect(resolveNestedWorkerMaxDepth({ nestedWorkerMaxDepth: value as unknown as number })).toBe(
      NESTED_WORKER_MAX_DEPTH_DEFAULT
    )
  })
})

describe('depth-exceeded message', () => {
  it('names both depths and tells the worker to finish the task itself', () => {
    const message = nestedWorkerDepthExceededMessage(2, 1)
    expect(message).toContain('depth 2 (max 1)')
    expect(message).toContain('Complete this task yourself')
  })
})

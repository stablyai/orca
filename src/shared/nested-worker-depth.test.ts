import { describe, expect, it } from 'vitest'
import {
  NESTED_WORKER_MAX_DEPTH_DEFAULT,
  migrateNestedWorkerMaxDepthDefault,
  nestedWorkerDepthExceededMessage,
  resolveNestedWorkerMaxDepth
} from './nested-worker-depth'

describe('resolveNestedWorkerMaxDepth', () => {
  it('defaults to 4 when unset', () => {
    expect(resolveNestedWorkerMaxDepth(undefined)).toBe(4)
    expect(resolveNestedWorkerMaxDepth(null)).toBe(4)
    expect(resolveNestedWorkerMaxDepth({})).toBe(4)
  })

  it('accepts whole numbers at or above 1', () => {
    expect(resolveNestedWorkerMaxDepth({ nestedWorkerMaxDepth: 1 })).toBe(1)
    expect(resolveNestedWorkerMaxDepth({ nestedWorkerMaxDepth: 3 })).toBe(3)
  })

  // Malformed settings must fall back to the cap, never disable nesting limits.
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

describe('migrateNestedWorkerMaxDepthDefault', () => {
  it('moves the old default of 1 to 4 once', () => {
    expect(migrateNestedWorkerMaxDepthDefault({ nestedWorkerMaxDepth: 1 })).toEqual({
      nestedWorkerMaxDepth: 4,
      nestedWorkerMaxDepthDefaultedToFour: true
    })
    expect(migrateNestedWorkerMaxDepthDefault(undefined).nestedWorkerMaxDepth).toBe(4)
  })

  it('keeps a deliberate value above 1', () => {
    expect(
      migrateNestedWorkerMaxDepthDefault({ nestedWorkerMaxDepth: 2 }).nestedWorkerMaxDepth
    ).toBe(2)
  })

  it('keeps 1 once the guard is stamped', () => {
    expect(
      migrateNestedWorkerMaxDepthDefault({
        nestedWorkerMaxDepth: 1,
        nestedWorkerMaxDepthDefaultedToFour: true
      }).nestedWorkerMaxDepth
    ).toBe(1)
  })
})

describe('depth-exceeded message', () => {
  it('names the cap and the refused depth, and says to finish here', () => {
    const message = nestedWorkerDepthExceededMessage(5, 4)
    expect(message).toContain('at most 4 levels deep')
    expect(message).toContain('(depth 5)')
    expect(message).toContain('Finish this task here')
  })
})

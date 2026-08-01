import { describe, expect, it } from 'vitest'
import { isSlowDispatchMethod, isSlowDispatchMutationMethod } from './runtime-slow-dispatch'

describe('runtime slow dispatch classification', () => {
  it.each(['worktree.create', 'browser.tabCreate', 'browser.snapshot'])(
    'keeps %s alive',
    (method) => {
      expect(isSlowDispatchMethod(method)).toBe(true)
    }
  )

  it('classifies only state-changing slow methods as mutations', () => {
    expect(isSlowDispatchMutationMethod('worktree.create')).toBe(true)
    expect(isSlowDispatchMutationMethod('browser.tabCreate')).toBe(true)
    expect(isSlowDispatchMutationMethod('browser.snapshot')).toBe(false)
    expect(isSlowDispatchMutationMethod('status.get')).toBe(false)
  })
})

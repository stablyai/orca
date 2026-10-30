import { describe, expect, it } from 'vitest'
import { isTopLevelView } from './top-level-view'
import { TopLevelViewSchema } from './rpc-contract/client-ui-params'

describe('isTopLevelView', () => {
  it('accepts canonical plugin routes and rejects malformed or inherited keys', () => {
    expect(isTopLevelView('plugin:samples.one/dashboard')).toBe(true)
    expect(isTopLevelView('plugin:samples.one/dashboard/extra')).toBe(false)
    expect(isTopLevelView('plugin:constructor')).toBe(false)
    expect(isTopLevelView('constructor')).toBe(false)
    expect(TopLevelViewSchema.safeParse('plugin:samples.one/dashboard').success).toBe(true)
    expect(TopLevelViewSchema.safeParse('plugin:samples.one/dashboard/extra').success).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { summarizeToolInput, truncateToolDetail } from './native-chat-tool-summary'

describe('summarizeToolInput', () => {
  it('ends before a split surrogate pair', () => {
    const prefix = `echo ${'a'.repeat(73)}`

    expect(summarizeToolInput(`${prefix}😀 tail`)).toBe(`${prefix}…`)
  })
})

describe('truncateToolDetail', () => {
  it('ends before a split surrogate pair', () => {
    const prefix = 'a'.repeat(3999)

    expect(truncateToolDetail(`${prefix}😀 tail`)).toBe(`${prefix}…`)
  })
})

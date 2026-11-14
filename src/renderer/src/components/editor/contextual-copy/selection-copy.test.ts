import { describe, expect, it } from 'vitest'
import { fencedCode } from './selection-copy'

describe('fencedCode', () => {
  it('fences text longer than any backtick run inside it, even a very long one', () => {
    expect(fencedCode('a ```js``` b\n', 'md')).toBe('````md\na ```js``` b\n````')
    const huge = '`a'.repeat(150_000)
    expect(fencedCode(huge)).toBe(`\`\`\`\n${huge}\n\`\`\``)
  })
})

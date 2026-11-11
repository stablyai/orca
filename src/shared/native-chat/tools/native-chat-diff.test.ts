import { describe, expect, it } from 'vitest'
import { diffFromText } from './native-chat-diff'

describe('diffFromText', () => {
  it('honors a smaller caller-owned aggregate row budget', () => {
    const text = Array.from(
      { length: 100 },
      (_unused, index) => `${index % 2 === 0 ? '+' : '-'}line-${index}`
    ).join('\n')

    expect(diffFromText(text, 20)).toHaveLength(20)
  })
})

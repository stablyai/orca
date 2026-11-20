import { describe, expect, it } from 'vitest'
import { botChatPreviewText } from './bot-chat-preview-text'

describe('botChatPreviewText', () => {
  it('keeps link labels and drops code ticks, bold and list marks', () => {
    expect(
      botChatPreviewText(
        'I merged [#1024](https://github.com/o/r/pull/1024) into **`main`**.\n- Two conflicts'
      )
    ).toBe('I merged #1024 into main. Two conflicts')
  })

  it('drops a markdown table', () => {
    expect(botChatPreviewText('Results:\n\n| Run | State |\n|---|---|\n| 36 | ok |')).toBe(
      'Results:'
    )
  })
})

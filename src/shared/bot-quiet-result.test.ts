import { describe, expect, it } from 'vitest'
import { isQuietBotResult, quietBotResultText } from './bot-quiet-result'

describe('a quiet bot result', () => {
  it('reads the marker as the last word, however it is dressed', () => {
    for (const ending of [
      'NO_REPLY',
      'NO_REPLY.',
      '`NO_REPLY`',
      '**NO_REPLY**',
      '_NO_REPLY_!',
      'NO_REPLY  \n'
    ]) {
      expect(isQuietBotResult(`Nothing new on the board.\n\n${ending}`)).toBe(true)
      expect(isQuietBotResult(ending)).toBe(true)
    }
  })

  it('never reads it among other text, or inside another word', () => {
    expect(isQuietBotResult('NO_REPLY but here is news')).toBe(false)
    expect(isQuietBotResult('XNO_REPLY')).toBe(false)
    expect(isQuietBotResult('The build passed.')).toBe(false)
  })

  it('keeps what came before the marker, and nothing of the marker', () => {
    expect(quietBotResultText('Checked the queue.\n\n**NO_REPLY.**')).toBe('Checked the queue.')
    expect(quietBotResultText('`NO_REPLY`')).toBe('')
  })
})

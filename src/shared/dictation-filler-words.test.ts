import { describe, expect, it } from 'vitest'
import { removeFillerWords } from './dictation-filler-words'

describe('removeFillerWords', () => {
  it.each([
    ['en', 'Um, I think we should, uh, ship it.', 'I think we should ship it.'],
    ['en', 'Let me check umm the logs.', 'Let me check the logs.'],
    ['en', 'Yes. Uh. No.', 'Yes. No.'],
    ['en', 'We should ship it, hmm', 'We should ship it'],
    ['en', 'we should um.', 'we should.'],
    ['en', 'We should ship, um.', 'We should ship.'],
    ['en', 'um so we ship', 'so we ship'],
    ['en', 'Um, iPhone builds first.', 'iPhone builds first.'],
    ['de', 'Äh, das ist um fünf Uhr fertig.', 'Das ist um fünf Uhr fertig.'],
    ['es', 'Ehm, creo que em funciona.', 'Creo que funciona.'],
    ['de', 'Das ist, ähm, um fünf Uhr fertig.', 'Das ist um fünf Uhr fertig.'],
    ['ru', 'Э, ну, давай так.', 'Ну, давай так.'],
    ['ja', 'えーと、明日の会議は、うーん、十時です。', '明日の会議は十時です。'],
    ['ko', '음, 내일 회의는 흠, 열 시예요.', '내일 회의는 열 시예요.'],
    ['zh', '嗯，我觉得，呃，这个可以。', '我觉得这个可以。'],
    ['zh', '額，我覺得可以。', '我覺得可以。'],
    ['en', 'UM I THINK WE SHOULD UH SHIP IT', 'I THINK WE SHOULD SHIP IT']
  ])('%s: %s', (language, text, expected) => {
    expect(removeFillerWords(text, [language])).toBe(expected)
  })

  it.each([
    ['en', 'I like it, so, well, we ship.'],
    ['en', 'The umbrella is humming, uh-huh.'],
    ['en', 'Hmm? What did you say?'],
    ['en', 'Ask UM and HMM about it.'],
    ['en', 'Open um.txt and set var_um to 3.'],
    ['ja', 'ええ、そうです。'],
    ['ko', '음이 너무 높아요.'],
    ['zh', '金额不对，那个文件也要改。'],
    ['zh', '嗯。']
  ])('%s keeps words with meaning: %s', (language, text) => {
    expect(removeFillerWords(text, [language])).toBe(text)
  })

  it('uses only fillers that are no word elsewhere when the language is unknown', () => {
    expect(removeFillerWords('Um carro, uh, azul.', undefined)).toBe('Um carro azul.')
    expect(removeFillerWords('Er kommt, hmm, morgen.', undefined)).toBe('Er kommt morgen.')
    expect(removeFillerWords('呃，好的。', undefined)).toBe('呃，好的。')
  })
})

import { describe, expect, it } from 'vitest'
import { botItemAskAdvice } from './bot-item-ask-advice'

const CLEAN_ASK = {
  context: 'The review is stuck: the reviewer is out of usage until Monday.',
  questions: [
    {
      prompt: 'Go ahead without the design review?',
      options: [{ label: 'Go ahead' }, { label: 'Wait' }],
      recommended: 0
    }
  ]
}

const codes = (input: Parameters<typeof botItemAskAdvice>[0]) =>
  botItemAskAdvice(input)?.codes ?? []

describe('botItemAskAdvice', () => {
  it('flags choices written into a prose ask', () => {
    expect(codes({ comment: 'Go ahead without review? Reply **yes**, or **wait**.' })).toEqual([
      'prose_choices'
    ])
    for (const comment of [
      'Which scope? A) simple, as written (recommended); B) the full one.',
      'Who cuts the release? Options: (a) Jinwoo; (b) you.',
      'Pick A/B/C for the title line?',
      "Can the worker start? Reply 'build' or 'wait'.",
      'Which icon? Option 2 is smaller.',
      'Pick one: keep it or drop it?'
    ]) {
      expect(codes({ comment })).toEqual(['prose_choices'])
    }
  })

  it('flags an ask with no question mark', () => {
    expect(codes({ comment: 'Need your call on the dialog wording.' })).toEqual(['no_question'])
    expect(
      codes({ ask: { questions: [{ prompt: 'Pick an icon', options: [{ label: 'A' }] }] } })
    ).toEqual(['no_question'])
  })

  it('flags a long question and a long prose lead', () => {
    const prompt = `Should ${'the fix '.repeat(18)}ship now?`
    expect(prompt.length).toBeGreaterThan(140)
    expect(codes({ ask: { questions: [{ prompt, options: [] }] } })).toEqual(['long_question'])
    expect(codes({ comment: `${'Some context. '.repeat(22)}Ship it?` })).toEqual(['long_question'])
    // A short first line with the facts as bullets is fine, however long the bullets run.
    expect(
      botItemAskAdvice({ comment: `Ship it now?\n\n${'- a fact about it\n'.repeat(20)}` })
    ).toBeNull()
  })

  it('flags long context over 300 characters or 5 lines', () => {
    expect(codes({ ask: { ...CLEAN_ASK, context: 'word '.repeat(61) } })).toEqual(['long_context'])
    expect(codes({ ask: { ...CLEAN_ASK, context: '- a\n- b\n- c\n- d\n- e\n- f' } })).toEqual([
      'long_context'
    ])
    expect(codes({ ask: { ...CLEAN_ASK, context: '- a\n- b\n- c\n- d\n- e' } })).toEqual([])
  })

  it('flags hashes, internal ids and run-together words outside code, links and paths', () => {
    expect(codes({ comment: 'Merge the fix at 363e3235aa01?' })).toEqual(['jargon'])
    expect(codes({ comment: 'Restart ctx_e24f9ab3c1d2?' })).toEqual(['jargon'])
    expect(
      codes({ comment: 'Is the questionalreadyNeedsyou and exactsentencewithoutspaces ok?' })
    ).toEqual(['jargon'])
    expect(
      botItemAskAdvice({
        comment:
          'Merge `363e3235aa01`? See https://github.com/o/r/commit/363e3235aa01 and ~/x/363e3235aa01.md, [the fix](https://x.dev/ctx_e24f9ab3c1d2).'
      })
    ).toBeNull()
    expect(
      botItemAskAdvice({ comment: 'Rename useBotItemView in NativeChatQuestionCard?' })
    ).toBeNull()
    expect(botItemAskAdvice({ comment: 'Does internationalization ship?' })).toBeNull()
  })

  it('reads an option after uppercase REPLY WITH and leaves a lowercase article alone', () => {
    expect(codes({ comment: 'Which one? REPLY WITH A or B.' })).toEqual(['prose_choices'])
    expect(codes({ comment: 'Which one? reply 2.' })).toEqual(['prose_choices'])
    expect(botItemAskAdvice({ comment: 'Should I REPLY WITH a summary?' })).toBeNull()
  })

  it('keeps what follows a link or a URL in the same word', () => {
    expect(botItemAskAdvice({ comment: 'Is [fix](x)?' })).toBeNull()
    expect(botItemAskAdvice({ comment: 'Is it at https://x.dev/a?b=1?' })).toBeNull()
    expect(codes({ comment: 'Is [fix](x)ctx_e24f9ab3c1d2 ok?' })).toEqual(['jargon'])
    expect(codes({ comment: 'Are [a](x),[b](y)/363e3235aa01 ok?' })).toEqual(['jargon'])
  })

  // Only a closed code span, fence or link target, or a URL up to its word's end, hides text; an id
  // anywhere else stays visible.
  it.each([
    ['unclosed link target keeps its question', 'Is [fix](unfinished?', []],
    ['unclosed link target keeps its id', 'Ship it? [plan](x,ctx_zzzzzzzz', ['jargon']],
    ['unclosed label', 'Ship it? [plan,ctx_zzzzzzzz', ['jargon']],
    ['after nested links', 'Ship it? [a]([b](c))ctx_zzzzzzzz', ['jargon']],
    ['after adjacent links', 'Ship it? [a](x)[b](y)ctx_zzzzzzzz', ['jargon']],
    ['unclosed backtick', 'Ship it? `ctx_zzzzzzzz', ['jargon']],
    ['backtick closed on another line', 'Ship it? `a\nctx_zzzzzzzz b`', ['jargon']],
    ['unclosed fence', 'Ship it?\n```\nctx_zzzzzzzz', ['jargon']],
    ['inside a closed fence', 'Ship it?\n```\nctx_zzzzzzzz\n```', []],
    ['inside a URL', 'Ship it? see,https://x.dev/ctx_zzzzzzzz', []],
    ['before a URL in the same word', 'Ship it? ctx_zzzzzzzz,https://x.dev', ['jargon']],
    ['three ticks closed by one tick', 'Ship it? ```ctx_zzzzzzzz`', ['jargon']],
    ['inside a closed two-tick span', 'Ship it? ``ctx_zzzzzzzz``', []],
    ['target with no label', 'Ship it? ](ctx_zzzzzzzz)', ['jargon']],
    ['label on another line', 'Ship it? [a\n](ctx_zzzzzzzz)', ['jargon']],
    ['target with a space', 'Ship it? [a](x ctx_zzzzzzzz)', ['jargon']],
    ['inside a link with a label of several words', 'Ship [the plan](ctx_zzzzzzzz)?', []]
  ])('masks: %s', (_name, comment, expected) => {
    expect(codes({ comment })).toEqual(expected)
  })

  it('skips ids inside parent-relative, Windows and wrapped paths', () => {
    for (const comment of [
      'Is ../runs/ctx_e24f9ab3c1d2/notes.md right?',
      'Is the log (~/runs/363e3235aa01.md) right?',
      'Is "/tmp/orca_session_id:abc/log" right?',
      'Is C:\\runs\\363e3235aa01.md right?'
    ]) {
      expect(botItemAskAdvice({ comment })).toBeNull()
    }
    expect(codes({ comment: 'Restart orca_session_id:abc now?' })).toEqual(['jargon'])
  })

  it('still skips links and URLs inside long runs without spaces', () => {
    expect(botItemAskAdvice({ comment: `Ship it?\n\n${'](x'.repeat(2_600)}` })).toBeNull()
    expect(
      botItemAskAdvice({ comment: `Ship it?\n\n${'a:/'.repeat(2_600)}https://x.dev/363e3235aa01` })
    ).toBeNull()
    expect(codes({ comment: `Ship it?\n\n${'a'.repeat(3_500)} ${'b'.repeat(3_500)}` })).toEqual([
      'jargon'
    ])
  })

  it('leaves review labels to the rule text', () => {
    expect(botItemAskAdvice({ comment: 'D4 needs P2 fixes on M4 Air; land it?' })).toBeNull()
  })

  it('reads an ask question without the question marks of its URLs and code', () => {
    const ask = (prompt: string) => ({ questions: [{ prompt, options: [] }] })
    expect(codes({ ask: ask('Read https://example.com/?page=1') })).toEqual(['no_question'])
    expect(codes({ ask: ask('Run `ls?` now') })).toEqual(['no_question'])
    expect(botItemAskAdvice({ ask: ask('Is https://example.com/?page=1 the one?') })).toBeNull()
  })

  it('flags choices written into an ask question or its context, never its buttons', () => {
    expect(
      codes({
        ask: { questions: [{ prompt: 'Ship it? Reply **yes**, or **wait**.', options: [] }] }
      })
    ).toEqual(['prose_choices'])
    expect(codes({ ask: { ...CLEAN_ASK, context: 'Options: (a) ship now; (b) wait.' } })).toEqual([
      'prose_choices'
    ])
    expect(
      botItemAskAdvice({
        ask: {
          questions: [
            {
              prompt: 'Which scope?',
              options: [{ label: 'A) simple (recommended)' }, { label: 'B) full' }]
            }
          ]
        }
      })
    ).toBeNull()
  })

  it('never pairs code across two fields of an ask', () => {
    expect(
      codes({
        ask: {
          questions: [
            { prompt: 'Keep ``` as the marker?', options: [] },
            { prompt: 'Ship it? Reply A or B. ```', options: [] }
          ]
        }
      })
    ).toEqual(['prose_choices'])
    expect(
      codes({
        ask: {
          context: 'Keep ``` here.',
          questions: [{ prompt: 'Restart ctx_zzzzzzzz? ```', options: [] }]
        }
      })
    ).toEqual(['jargon'])
  })

  it('reads the decisions of an ask, not the text written for older hosts', () => {
    expect(
      codes({
        comment: 'Go ahead?\n   - Go ahead (recommended)\n   - Wait',
        ask: CLEAN_ASK
      })
    ).toEqual([])
    expect(codes({ ask: { ...CLEAN_ASK, context: 'Head 363e3235aa01 is ready.' } })).toEqual([
      'jargon'
    ])
  })

  it('names every code but tips only the first one', () => {
    const advice = botItemAskAdvice({
      comment: `Head 363e3235aa01. ${'Context. '.repeat(40)}Reply A or B.`
    })
    expect(advice?.codes).toEqual(['prose_choices', 'no_question', 'long_question', 'jargon'])
    expect(advice?.tip).toContain('--option values after --ask')
  })

  it('reads only the first 8,000 characters', () => {
    expect(
      botItemAskAdvice({ comment: `Ship it?\n\n${'- ok\n'.repeat(1_700)}363e3235aa01` })
    ).toBeNull()
  })
})

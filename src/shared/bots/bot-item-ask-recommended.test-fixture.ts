import type { BotItemAsk } from './bot-item-ask'

type Question = BotItemAsk['questions'][number]

const question = (
  prompt: string,
  labels: string[],
  extra: Omit<Question, 'prompt' | 'options'> = {}
): Question => ({ prompt, options: labels.map((label) => ({ label })), ...extra })
const ask = (...questions: Question[]): BotItemAsk => ({ questions })
/** An ask the host stores exactly as written. */
const kept = (...questions: Question[]) => ({
  written: ask(...questions),
  stored: ask(...questions)
})

/** Asks an agent wrote with "(Recommended)" in a label, and the ask the host stores for each. The host
 *  test writes `written` through the item store and expects `stored`; the desktop and phone tests
 *  render `stored`, so both ends hold the same contract. */
export const RECOMMENDED_ASKS = {
  // Written only: the words become the flag.
  written: {
    written: ask(
      question('Waive the old warning?', ['Waive; ship it disclosed (Recommended)', 'Fix it first'])
    ),
    stored: ask(
      question('Waive the old warning?', ['Waive; ship it disclosed', 'Fix it first'], {
        recommended: 0
      })
    )
  },
  // Flagged and written: the flag stays, the words go.
  flagged: {
    written: ask(
      question('Merge without the review?', ['Merge now', 'Wait for Monday [recommended]'], {
        recommended: 1
      })
    ),
    stored: ask(
      question('Merge without the review?', ['Merge now', 'Wait for Monday'], { recommended: 1 })
    )
  },
  // A twin keeps its words, and no flag is read from them.
  twin: kept(question('Close it?', ['Go', 'Go (Recommended)'])),
  // Pick several with ", " in a label: every label stays as written.
  joined: kept(
    question('Which follow-ups?', ['Audit', 'Notify', 'Audit, Notify (Recommended)'], {
      multi: true
    })
  ),
  // Several questions, answered on the stepped card: each keeps its own flag.
  several: {
    written: ask(
      question('Ship the sidebar?', ['Ship it (Recommended)', 'Beta first'], { recommended: 0 }),
      question('Keep the old layout?', ['Yes, for a month', 'No [recommended]'])
    ),
    stored: ask(
      question('Ship the sidebar?', ['Ship it', 'Beta first'], { recommended: 0 }),
      question('Keep the old layout?', ['Yes, for a month', 'No'], { recommended: 1 })
    )
  },
  // Pick several where a cleaned label would join into a sibling ("Audit" + "(Recommended)"): all stay.
  delimited: kept(
    question(
      'Which follow-ups?',
      ['Audit, (Recommended)', 'Audit,', 'Audit [recommended]', '(Recommended)'],
      { recommended: 2, multi: true }
    )
  ),
  // The same options reordered, the flag moving with its option.
  delimitedReordered: kept(
    question(
      'Which follow-ups?',
      ['(Recommended)', 'Audit [recommended]', 'Audit,', 'Audit, (Recommended)'],
      { recommended: 1, multi: true }
    )
  ),
  // Cleaning would leave an attached mark the phone reads as one: the words stay.
  attached: kept(question('Go?', ['Wait', 'Go(Recommended) [recommended]'], { recommended: 0 })),
  // A flag on the plain twin: the marked twin keeps its words.
  twinFlagged: kept(question('Close it?', ['Go', 'Go (Recommended)'], { recommended: 0 })),
  // Cleaning one twin leaves an attached literal beside it: each row reads as written.
  bracketAttached: {
    written: ask(question('Go?', ['Go [recommended]', 'Go(Recommended)'])),
    stored: ask(question('Go?', ['Go', 'Go(Recommended)'], { recommended: 0 }))
  },
  // Pick several kept as written for its ", ", with the flag on another option.
  commaWait: kept(
    question('Which?', ['A, (Recommended)', 'Wait'], { recommended: 1, multi: true })
  ),
  // Two sets of picks that join alike if the mark goes: kept as written.
  subsets: kept(
    question('Which parts?', ['A, B (Recommended)', 'C', 'A', 'B, C'], { multi: true })
  ),
  subsetsReordered: kept(
    question('Which parts?', ['B, C', 'A', 'C', 'A, B (Recommended)'], { multi: true })
  ),
  // Several questions, whose answer lines fold spacing: the spaced label stays as written.
  severalFolded: kept(
    question('Scope?', ['Audit,  Notify (Recommended)', 'Audit', 'Notify'], { multi: true }),
    question('Ship?', ['Yes', 'No'])
  ),
  // A label of several lines that, cleaned, would read like the whole answer to both questions.
  multiline: kept(
    question('First?', ['A', 'A\nSecond? → B (Recommended)']),
    question('Second?', ['B', 'C'])
  ),
  // An authored option that, cleaned, says what the phone's own free-text row used to.
  otherAuthored: {
    written: ask(question('Go?', ['Other… [recommended]', 'Wait'])),
    stored: ask(question('Go?', ['Other…', 'Wait'], { recommended: 0 }))
  },
  // An authored option in the very words of the phone's free-text action.
  typeAnswerAuthored: kept(question('Go?', ['Type your answer', 'Wait'], { recommended: 1 }))
} satisfies Record<string, { written: BotItemAsk; stored: BotItemAsk }>

/** The comment each surface posts for these asks: the desktop browser check and the phone card test
 *  assert their sends equal these, and the host test posts them through the owner's comment path. */
export const RECOMMENDED_ASK_ANSWERS = {
  written: 'Waive; ship it disclosed',
  flagged: 'Wait for Monday',
  twin: 'Go (Recommended)',
  // Pick several: two picks joined, and the one option that reads like them.
  joinedTwo: 'Audit, Notify',
  joinedBundled: 'Audit, Notify (Recommended)',
  several: 'Ship the sidebar? → Ship it\nKeep the old layout? → No',
  // Option 0 alone, and options 2 and 3 together (tapped 3 then 2): different words.
  delimitedOne: 'Audit, (Recommended)',
  delimitedPair: 'Audit [recommended], (Recommended)',
  // Reordered: the same two choices, picks joined in display order.
  delimitedReorderedOne: 'Audit, (Recommended)',
  delimitedReorderedPair: '(Recommended), Audit [recommended]',
  attached: 'Go(Recommended) [recommended]',
  twinFlaggedPlain: 'Go',
  twinFlaggedMarked: 'Go (Recommended)',
  bracketAttachedClean: 'Go',
  bracketAttachedLiteral: 'Go(Recommended)',
  commaWaitLiteral: 'A, (Recommended)',
  commaWaitFlag: 'Wait',
  // Options 0+1 and options 2+3, joined in display order.
  subsetsFirst: 'A, B (Recommended), C',
  subsetsSecond: 'A, B, C',
  // Reordered: options 0+1 and 2+3 are the same choices the other way round.
  subsetsReorderedFirst: 'B, C, A',
  subsetsReorderedSecond: 'C, A, B (Recommended)',
  // The answer lines fold spacing; the label's own words still differ from the two picks.
  severalFoldedPair: 'Scope? → Audit, Notify\nShip? → Yes',
  severalFoldedOne: 'Scope? → Audit, Notify (Recommended)\nShip? → Yes',
  // Stepped: A for the first question, B for the second.
  multilineStepped: 'First? → A\nSecond? → B',
  otherAuthored: 'Other…',
  typeAnswerAuthored: 'Type your answer'
} as const

import type { BotItemAsk } from './bot-item-ask'

/** Asks an agent wrote with "(Recommended)" in a label, and the ask the host stores for each. The host
 *  test writes `written` through the item store and expects `stored`; the desktop and phone tests
 *  render `stored`, so both ends hold the same contract. */
export const RECOMMENDED_ASKS = {
  // Written only: the words become the flag.
  written: {
    written: {
      questions: [
        {
          prompt: 'Waive the old warning?',
          options: [{ label: 'Waive; ship it disclosed (Recommended)' }, { label: 'Fix it first' }]
        }
      ]
    },
    stored: {
      questions: [
        {
          prompt: 'Waive the old warning?',
          options: [{ label: 'Waive; ship it disclosed' }, { label: 'Fix it first' }],
          recommended: 0
        }
      ]
    }
  },
  // Flagged and written: the flag stays, the words go.
  flagged: {
    written: {
      questions: [
        {
          prompt: 'Merge without the review?',
          options: [{ label: 'Merge now' }, { label: 'Wait for Monday [recommended]' }],
          recommended: 1
        }
      ]
    },
    stored: {
      questions: [
        {
          prompt: 'Merge without the review?',
          options: [{ label: 'Merge now' }, { label: 'Wait for Monday' }],
          recommended: 1
        }
      ]
    }
  },
  // A twin keeps its words, and no flag is read from them.
  twin: {
    written: {
      questions: [
        { prompt: 'Close it?', options: [{ label: 'Go' }, { label: 'Go (Recommended)' }] }
      ]
    },
    stored: {
      questions: [
        { prompt: 'Close it?', options: [{ label: 'Go' }, { label: 'Go (Recommended)' }] }
      ]
    }
  },
  // Pick several with ", " in a label: every label stays as written.
  joined: {
    written: {
      questions: [
        {
          prompt: 'Which follow-ups?',
          options: [
            { label: 'Audit' },
            { label: 'Notify' },
            { label: 'Audit, Notify (Recommended)' }
          ],
          multi: true
        }
      ]
    },
    stored: {
      questions: [
        {
          prompt: 'Which follow-ups?',
          options: [
            { label: 'Audit' },
            { label: 'Notify' },
            { label: 'Audit, Notify (Recommended)' }
          ],
          multi: true
        }
      ]
    }
  },
  // Several questions, answered on the stepped card: each keeps its own flag.
  several: {
    written: {
      questions: [
        {
          prompt: 'Ship the sidebar?',
          options: [{ label: 'Ship it (Recommended)' }, { label: 'Beta first' }],
          recommended: 0
        },
        {
          prompt: 'Keep the old layout?',
          options: [{ label: 'Yes, for a month' }, { label: 'No [recommended]' }]
        }
      ]
    },
    stored: {
      questions: [
        {
          prompt: 'Ship the sidebar?',
          options: [{ label: 'Ship it' }, { label: 'Beta first' }],
          recommended: 0
        },
        {
          prompt: 'Keep the old layout?',
          options: [{ label: 'Yes, for a month' }, { label: 'No' }],
          recommended: 1
        }
      ]
    }
  }
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
  several: 'Ship the sidebar? → Ship it\nKeep the old layout? → No'
} as const

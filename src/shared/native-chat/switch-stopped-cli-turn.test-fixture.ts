import type { AgentJournalRenderItem } from '../agent-session-journal-types'

// The journal a recorded Claude CLI turn (main's `__fixtures__/claude-cli-switch-2.1.302.jsonl`,
// first two rows) leaves after a switch stopped it: imported, then caught up as a person's Stop.
// Main's switch-import test proves the import produces exactly these items; the chat renders them.

const SESSION = '402eff2b-84dc-4e05-8fe8-49fffb2cd3c3'
const TURN = '124e6d1a-016e-46a5-8113-6a893a97b769'

export const SWITCH_STOPPED_CLI_USER_ITEM_KEY = `claude:${SESSION}:${TURN}`
export const SWITCH_STOPPED_CLI_TURN_ID = TURN

export const SWITCH_STOPPED_CLI_TURN_ITEMS: AgentJournalRenderItem[] = [
  {
    itemId: SWITCH_STOPPED_CLI_USER_ITEM_KEY,
    revision: 1,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [
        {
          type: 'text',
          text: 'Think briefly, then read notes.txt with the Read tool, then answer in two short paragraphs what it says.'
        }
      ]
    },
    sequence: 2,
    observedAt: 1792607323188,
    turnScope: { kind: 'thread' }
  },
  {
    itemId: `claude:${SESSION}:ec769311-5ca1-4473-9aef-6eb98c796aea`,
    revision: 1,
    body: {
      kind: 'tool-call',
      name: 'Read',
      input: { file_path: '/workspace/notes.txt' },
      callId: 'toolu_01JdDiY9LSSGER1aErtVjSW3',
      state: 'completed'
    },
    sequence: 3,
    observedAt: 1792607327931,
    turnScope: { kind: 'thread' }
  },
  {
    itemId: `legacy:claude:${SESSION}:turn-lifecycle%3A${TURN}`,
    revision: 1,
    // The Stop names no start: an imported turn never invents elapsed time.
    body: {
      kind: 'turn',
      turnId: TURN,
      userItemId: SWITCH_STOPPED_CLI_USER_ITEM_KEY,
      state: 'interrupted',
      outcome: 'cancellation'
    },
    sequence: 4,
    // Written when the switch caught up; main's test reads it as any time.
    observedAt: 1793414497171,
    turnScope: { kind: 'thread' }
  }
]

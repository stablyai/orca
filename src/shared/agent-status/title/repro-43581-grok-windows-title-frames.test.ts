import { describe, expect, it } from 'vitest'

import { collectAgentTitleEvidence } from './agent-title-evidence'
import { detectAgentStatusFromTitle, normalizeTerminalTitle } from './agent-title-status'

// Grok 1.0.88 frames: macOS bytes captured from a PTY; Windows swaps the spinner for | / - \ and ⚠ for ! (#43581 video).
const CAPTURED_TURN = [
  ['⠙ - Waiting for response… - grok', '| - Waiting for response… - grok'],
  ['⠹ - Thinking - grok', '/ - Thinking - grok'],
  [
    '⠸ - Remove old.txt if present, then sleep 30… - Run rm old.txt and sleep command - grok',
    '- - Remove old.txt if present, then sleep 30… - Run rm old.txt and sleep command - grok'
  ],
  [
    '⚠ Action required - ⠼ - Remove old.txt if present, then sleep 30… - Run rm old.txt and sleep command - grok',
    '! Action required - \\ - Remove old.txt if present, then sleep 30… - Run rm old.txt and sleep command - grok'
  ],
  ['Run rm old.txt and sleep command - grok', 'Run rm old.txt and sleep command - grok']
] as const

const EXPECTED = [
  ['⠋ Grok', 'working', 'grok'],
  ['⠋ Grok', 'working', 'grok'],
  ['⠋ Grok', 'working', 'grok'],
  ['Grok - action required', 'permission', 'grok'],
  ['Run rm old.txt and sleep command - grok', 'idle', 'grok']
]

describe('Grok title frames (#43581)', () => {
  it.each([
    ['macOS', 0],
    ['Windows', 1]
  ] as const)(
    'collapses %s spinner and action-required frames to one Grok label per state',
    (_, column) => {
      const read = CAPTURED_TURN.map((frames) => {
        const normalized = normalizeTerminalTitle(frames[column])
        return [
          normalized,
          detectAgentStatusFromTitle(frames[column]),
          collectAgentTitleEvidence(normalized).agent
        ]
      })
      expect(read).toEqual(EXPECTED)
    }
  )
})

import { describe, expect, it } from 'vitest'
import { readFreebuffScreenStatus } from './freebuff-screen-status'

describe('readFreebuffScreenStatus', () => {
  it.each(['260.6K (25%)', '4:59 left · 13.3K (1%)'])(
    'reports done for an idle bar labelled %s',
    (label) => {
      const lines = [
        ' ⎘ • 13m 52s • △▽',
        ` ${label.padEnd(60)}✕ End session`,
        ' ╭──────────────────────────────────────────────────────────────╮',
        ' │  Enter a coding task or / for commands                       │',
        ' ╰──────────────────────────────────────────────────────────────╯',
        ' DeepSeek V4 Flash • high · /tmp/repo · /model to change · Chat: Fix session status'
      ]

      expect(readFreebuffScreenStatus(lines, true)).toEqual({ state: 'done' })
    }
  )
})

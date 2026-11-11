import { describe, expect, it } from 'vitest'
import { tidyTerminalTail } from './tidy-terminal-tail'

const P = 'ubuntu@w2slot:~/orca/workspaces/Hello-World/w2slot$'

describe('the read-only copy of a terminal', () => {
  it('puts each boot’s prompt on its own line', () => {
    expect(tidyTerminalTail([`${P} ${P} ${P} `])).toEqual([P, P, P])
    // Glued with no space too.
    expect(tidyTerminalTail([`${P}${P}`])).toEqual([P, P])
  })

  it('starts at the first line with output and drops trailing blank rows', () => {
    expect(tidyTerminalTail(['', '   ', '', `${P} echo hi`, 'hi', `${P} `, '', ''])).toEqual([
      `${P} echo hi`,
      'hi',
      P
    ])
  })

  it('leaves ordinary output alone, including addresses and blank lines inside it', () => {
    const lines = ['$ git log', 'Author: Ada <ada@example.com>', '', 'commit abc', 'cost: $5 a@b:c']
    expect(tidyTerminalTail(lines)).toEqual(lines)
  })
})

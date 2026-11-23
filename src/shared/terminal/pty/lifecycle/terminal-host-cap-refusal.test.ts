import { describe, expect, it } from 'vitest'
import {
  readTerminalHostCapRefusal,
  TerminalHostCapError,
  terminalUsageNotice
} from './terminal-host-cap-refusal'

describe('terminal host cap', () => {
  it('reads the counts back from any wrapping of the refusal message', () => {
    const wrapped = `Failed to create the startup terminal for /repo/wt: ${new TerminalHostCapError(250, 256).message}`

    expect(readTerminalHostCapRefusal(new Error(wrapped))).toEqual({
      code: 'terminal_host_cap',
      inUse: 250,
      limit: 256
    })
  })

  it('names terminal usage from 80% of the cap, and not below it', () => {
    expect(terminalUsageNotice({ terminalsInUse: 205, maxTerminals: 256 })).toBe(
      '205 of 256 in use on this computer; release finished workers with `orca orchestration worker-release --dispatch <dispatch_id>` (list them with `orca orchestration worker-list --terminal-state reclaimable`)'
    )
    expect(terminalUsageNotice({ terminalsInUse: 8, maxTerminals: 10 })).toContain('8 of 10')
    expect(terminalUsageNotice({ terminalsInUse: 204, maxTerminals: 256 })).toBeUndefined()
    expect(terminalUsageNotice(null)).toBeUndefined()
    expect(terminalUsageNotice({ terminalsInUse: 3, maxTerminals: 0 })).toBeUndefined()
  })
})

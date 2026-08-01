import { describe, expect, it } from 'vitest'
import { collectRendererMemoryProfileCounts } from './renderer-memory-profile'
import {
  readTerminalOutputBacklogCensus,
  setTerminalOutputBacklogCensusReader
} from './terminal-output-backlog-census'

describe('terminal output backlog census', () => {
  it('reports zeros before the scheduler installs a reader, so a missing key means the instrument never ran', () => {
    expect(readTerminalOutputBacklogCensus()).toEqual({
      terminals: 0,
      chars: 0,
      maxTerminalChars: 0
    })
    expect(collectRendererMemoryProfileCounts()).toMatchObject({
      'terminalOutputBacklog.terminals': 0,
      'terminalOutputBacklog.chars': 0,
      'terminalOutputBacklog.maxTerminalChars': 0
    })
  })

  it('surfaces the queued characters the store profile structurally cannot see', () => {
    // Why: the queue is a module-global Map in the output scheduler, capped per
    // terminal (2MB at the default scrollback) but unbounded across terminals.
    setTerminalOutputBacklogCensusReader(() => ({
      terminals: 170,
      chars: 356_515_840,
      maxTerminalChars: 2_097_152
    }))

    expect(collectRendererMemoryProfileCounts()).toMatchObject({
      'terminalOutputBacklog.terminals': 170,
      'terminalOutputBacklog.chars': 356_515_840,
      'terminalOutputBacklog.maxTerminalChars': 2_097_152
    })

    setTerminalOutputBacklogCensusReader(() => ({
      terminals: 0,
      chars: 0,
      maxTerminalChars: 0
    }))
  })
})

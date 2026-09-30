import { describe, expect, it } from 'vitest'
import { getAgentLabel, resolveTerminalTitleAgentType } from './terminal-title-agent-type'

// Why: Kiro (kiro-cli) writes NO OSC title in any state — verified from a real PTY
// capture of `kiro-cli chat --tui` (v2.23.0), which emits only an OSC 11 background-color
// query, no OSC 0/1/2 title and no OSC 9999 status. Like ZCode, Orca must synthesize its
// status titles, and those synthetic frames must resolve back to the `kiro` identity so
// the sidebar shows the Kiro icon plus working/idle state.
describe('Kiro synthetic title identity', () => {
  it('labels an idle synthetic title as Kiro', () => {
    expect(getAgentLabel('Kiro ready')).toBe('Kiro')
    expect(resolveTerminalTitleAgentType('Kiro ready')).toBe('kiro')
  })

  it('labels a working synthetic spinner frame as Kiro', () => {
    expect(getAgentLabel('\u280b Kiro')).toBe('Kiro')
    expect(resolveTerminalTitleAgentType('\u280b Kiro')).toBe('kiro')
  })

  it('labels a permission synthetic title as Kiro', () => {
    expect(getAgentLabel('Kiro - action required')).toBe('Kiro')
  })

  it('does not classify a plain cwd path containing kiro as Kiro', () => {
    expect(getAgentLabel('~/projects/kiro-notes')).toBeNull()
  })
})

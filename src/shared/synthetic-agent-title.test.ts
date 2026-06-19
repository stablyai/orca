import { describe, expect, it } from 'vitest'
import {
  getSyntheticAgentTerminalTitle,
  shouldDriveSyntheticAgentTitleFromHook
} from './synthetic-agent-title'

describe('synthetic agent titles', () => {
  it('provides terminal-state titles for Codex hook completion', () => {
    expect(getSyntheticAgentTerminalTitle('codex', 'done')).toBe('Codex ready')
    expect(getSyntheticAgentTerminalTitle('codex', 'waiting')).toBe('Codex - action required')
  })

  it('does not synthesize Codex working titles over Codex native spinner titles', () => {
    expect(shouldDriveSyntheticAgentTitleFromHook('codex', 'working')).toBe(false)
    expect(shouldDriveSyntheticAgentTitleFromHook('codex', 'done')).toBe(true)
  })

  it('provides Devin titles for hook-driven status updates', () => {
    expect(getSyntheticAgentTerminalTitle('devin', 'done')).toBe('Devin ready')
    expect(getSyntheticAgentTerminalTitle('devin', 'waiting')).toBe('Devin - action required')
    expect(shouldDriveSyntheticAgentTitleFromHook('devin', 'working')).toBe(true)
  })
})

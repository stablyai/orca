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

  it('does not synthesize OpenCode titles over native session titles', () => {
    expect(getSyntheticAgentTerminalTitle('opencode', 'done')).toBeNull()
    expect(getSyntheticAgentTerminalTitle('opencode', 'waiting')).toBeNull()
    expect(shouldDriveSyntheticAgentTitleFromHook('opencode', 'working')).toBe(false)
    expect(shouldDriveSyntheticAgentTitleFromHook('opencode', 'done')).toBe(false)
    expect(shouldDriveSyntheticAgentTitleFromHook('opencode', 'waiting')).toBe(false)
  })

  it('provides Devin titles for hook-driven status updates', () => {
    expect(getSyntheticAgentTerminalTitle('devin', 'done')).toBe('Devin ready')
    expect(getSyntheticAgentTerminalTitle('devin', 'waiting')).toBe('Devin - action required')
    expect(shouldDriveSyntheticAgentTitleFromHook('devin', 'working')).toBe(true)
  })

  it('provides Pi-compatible OMP titles for hook-driven status updates', () => {
    expect(getSyntheticAgentTerminalTitle('omp', 'done')).toBe('OMP ready')
    expect(getSyntheticAgentTerminalTitle('omp', 'waiting')).toBe('OMP - action required')
    expect(shouldDriveSyntheticAgentTitleFromHook('omp', 'working')).toBe(true)
  })

  it('provides Pi titles for hook-driven status updates', () => {
    expect(getSyntheticAgentTerminalTitle('pi', 'done')).toBe('Pi ready')
    expect(getSyntheticAgentTerminalTitle('pi', 'waiting')).toBe('Pi - action required')
    expect(shouldDriveSyntheticAgentTitleFromHook('pi', 'working')).toBe(true)
  })
})

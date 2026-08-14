import { describe, expect, it } from 'vitest'
import { agentSeedsLaunchStatus, buildLaunchStatusSeedPayload } from './agent-launch-status-seed'

describe('agentSeedsLaunchStatus', () => {
  it('covers Codex, whose idle TUI posts no hook until the first prompt', () => {
    expect(agentSeedsLaunchStatus('codex')).toBe(true)
  })

  it('keeps covering Command Code', () => {
    expect(agentSeedsLaunchStatus('command-code')).toBe(true)
  })

  it('excludes agents that publish a SessionStart row at TUI open', () => {
    expect(agentSeedsLaunchStatus('claude')).toBe(false)
    expect(agentSeedsLaunchStatus('gemini')).toBe(false)
  })

  it('is false for an unknown launch agent', () => {
    expect(agentSeedsLaunchStatus(undefined)).toBe(false)
  })
})

describe('buildLaunchStatusSeedPayload', () => {
  it('reports working when the launch submits a prompt', () => {
    expect(buildLaunchStatusSeedPayload('codex', 'say hi')).toEqual({
      state: 'working',
      prompt: 'say hi',
      agentType: 'codex'
    })
  })

  it('trims the submitted prompt', () => {
    expect(buildLaunchStatusSeedPayload('codex', '  say hi  ')).toMatchObject({
      state: 'working',
      prompt: 'say hi'
    })
  })

  it('lands an idle session-boundary row when the launch submits nothing', () => {
    expect(buildLaunchStatusSeedPayload('codex', '')).toEqual({
      state: 'done',
      prompt: '',
      agentType: 'codex',
      sessionBoundary: true
    })
  })

  it('treats a whitespace-only prompt as no prompt, so no phantom spinner runs', () => {
    expect(buildLaunchStatusSeedPayload('codex', '   \n ')).toMatchObject({
      state: 'done',
      sessionBoundary: true
    })
  })
})

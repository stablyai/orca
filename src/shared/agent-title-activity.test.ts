import { describe, expect, it } from 'vitest'
import { detectAgentStatusFromTitle, readAgentTitleActivity } from './agent-title-status'

// Hand-built titles throughout; the committed-recording cases live in the sidebar row tests.
const NAME_ONLY_TITLES = ['agy', 'grok', 'OpenCode', 'Codex', 'aider', 'Gemini CLI']

describe('readAgentTitleActivity', () => {
  it.each(NAME_ONLY_TITLES)('reads the bare name %s as unreported, not idle', (title) => {
    expect(readAgentTitleActivity(title)).toBe('unreported')
  })

  it.each([
    ['⠋ Codex', 'working'],
    ['✳ Claude Code', 'idle'],
    ['agy ready', 'idle'],
    ['Codex action required', 'permission']
  ] as const)('keeps the marker in %s as evidence: %s', (title, activity) => {
    expect(readAgentTitleActivity(title)).toBe(activity)
    expect(detectAgentStatusFromTitle(title)).toBe(activity)
  })

  it.each(['zsh', 'demo-repo', 'Droid', 'Cursor Agent'])('finds no activity in %s', (title) => {
    expect(readAgentTitleActivity(title)).toBeNull()
    expect(detectAgentStatusFromTitle(title)).toBeNull()
  })
})

describe('detectAgentStatusFromTitle (temporary wrapper)', () => {
  it.each(NAME_ONLY_TITLES)('still reads the bare name %s as idle for settle readers', (title) => {
    expect(detectAgentStatusFromTitle(title)).toBe('idle')
  })
})

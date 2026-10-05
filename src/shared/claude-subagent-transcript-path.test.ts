import { describe, expect, it } from 'vitest'
import { claudeSubagentTranscriptPath } from './claude-subagent-transcript-path'

describe('claudeSubagentTranscriptPath', () => {
  it('places the transcript in the subagents dir named after the parent transcript', () => {
    expect(
      claudeSubagentTranscriptPath('/home/u/.claude/projects/-home-u-app/693d.jsonl', 'aba4e562')
    ).toBe('/home/u/.claude/projects/-home-u-app/693d/subagents/agent-aba4e562.jsonl')
  })

  it('keeps a Windows parent path in Windows form', () => {
    expect(
      claudeSubagentTranscriptPath('C:\\Users\\u\\.claude\\projects\\p\\693d.jsonl', 'a1')
    ).toBe('C:\\Users\\u\\.claude\\projects\\p\\693d\\subagents\\agent-a1.jsonl')
  })

  it.each(['../x', 'a/b', 'a\\b', '', 'a.b'])(
    'refuses an id that is not a file-name id: %j',
    (id) => {
      expect(claudeSubagentTranscriptPath('/p/693d.jsonl', id)).toBeNull()
    }
  )

  it('refuses a parent path without a directory', () => {
    expect(claudeSubagentTranscriptPath('693d.jsonl', 'a1')).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { resumeActivityLabel } from './native-chat-resume-activity-label'

describe('resumeActivityLabel', () => {
  it('says nothing for an offer from a host that recorded no activity', () => {
    expect(resumeActivityLabel(undefined)).toBeNull()
  })

  it('names a lead that was mid-reply', () => {
    expect(resumeActivityLabel({ state: 'working', prompts: [], tasks: [] })?.summary).toBe(
      'Was mid-reply'
    )
  })

  // A blocked lead names the prompt the user was being asked, not a reply of its own.
  it('names the prompt a waiting chat lost', () => {
    expect(
      resumeActivityLabel({
        state: 'blocked',
        prompts: [{ kind: 'approval', label: 'Bash' }],
        tasks: []
      })?.summary
    ).toBe('Waiting for your approval: Bash')
  })

  // A settled lead says nothing about itself; its children are the whole story.
  it('says nothing for a settled lead beyond its tasks', () => {
    expect(
      resumeActivityLabel({
        state: 'done',
        prompts: [],
        tasks: [{ kind: 'agent', label: 'Review loop 4' }]
      })?.summary
    ).toBe('Subagent running: Review loop 4')
  })

  it('tells subagents apart from monitoring, as the sidebar does', () => {
    expect(
      resumeActivityLabel({
        state: 'done',
        prompts: [],
        tasks: [
          { kind: 'agent', label: 'Review loop 4' },
          { kind: 'command', label: 'Watch CI' }
        ]
      })
    ).toEqual({
      summary: 'Subagent running: Review loop 4 · Monitoring: Watch CI',
      detail: 'Review loop 4\nWatch CI'
    })
  })

  it('counts several of a kind instead of naming them', () => {
    expect(
      resumeActivityLabel({
        state: 'done',
        prompts: [],
        tasks: [
          { kind: 'agent', label: 'One' },
          { kind: 'agent', label: 'Two' },
          { kind: 'monitor', label: '' },
          { kind: 'workflow', label: 'Deploy' }
        ]
      })?.summary
    ).toBe('2 subagents running · Monitoring 2 background tasks')
  })

  // The roster also lists the foreground command a reply is running; that is not monitoring.
  it('does not call a mid-reply command monitoring, but keeps it in the detail', () => {
    expect(
      resumeActivityLabel({
        state: 'working',
        prompts: [],
        tasks: [{ kind: 'command', label: 'Count .plist files' }]
      })
    ).toEqual({ summary: 'Was mid-reply', detail: 'Count .plist files' })
  })

  it('returns null for a settled lead with nothing running', () => {
    expect(resumeActivityLabel({ state: 'done', prompts: [], tasks: [] })).toBeNull()
  })
})

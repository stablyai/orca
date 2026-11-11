import { describe, expect, it } from 'vitest'
import { getActivityThreadTaskTitle } from './activity-thread-display'

const resumePrompt = 'Picking this back up after a restart.'

function entry(prompt = resumePrompt) {
  return { orchestration: undefined, prompt, stateHistory: [] }
}

describe('getActivityThreadTaskTitle', () => {
  it('uses a named session title instead of the first prompt a resumed tab saw', () => {
    expect(
      getActivityThreadTaskTitle({
        entry: entry(),
        generatedTitlesEnabled: true,
        tab: {
          customTitle: null,
          generatedTitle: resumePrompt,
          title: 'Claude',
          defaultTitle: 'Terminal',
          aiVaultTitle: {
            agent: 'claude',
            sessionId: 'session-1',
            title: 'Triage lead handover',
            kind: 'named'
          }
        }
      })
    ).toBe('Triage lead handover')
  })

  it('keeps a typed tab name ahead of the session name', () => {
    expect(
      getActivityThreadTaskTitle({
        entry: entry(),
        generatedTitlesEnabled: true,
        tab: {
          customTitle: 'Handover',
          generatedTitle: resumePrompt,
          title: 'Claude',
          defaultTitle: 'Terminal',
          aiVaultTitle: {
            agent: 'claude',
            sessionId: 'session-1',
            title: 'Triage lead handover',
            kind: 'named'
          }
        }
      })
    ).toBe('Handover')
  })

  it('still uses the generated title when the session title is only a fallback', () => {
    expect(
      getActivityThreadTaskTitle({
        entry: entry(),
        generatedTitlesEnabled: true,
        tab: {
          customTitle: null,
          generatedTitle: 'First prompt in this tab',
          title: 'Claude',
          defaultTitle: 'Terminal',
          aiVaultTitle: {
            agent: 'claude',
            sessionId: 'session-1',
            title: 'Older stand-in',
            kind: 'fallback'
          }
        }
      })
    ).toBe('First prompt in this tab')
  })

  it('keeps the named session title when generated titles are off', () => {
    expect(
      getActivityThreadTaskTitle({
        entry: entry(),
        generatedTitlesEnabled: false,
        tab: {
          customTitle: null,
          generatedTitle: resumePrompt,
          title: 'Claude',
          defaultTitle: 'Terminal',
          aiVaultTitle: {
            agent: 'claude',
            sessionId: 'session-1',
            title: 'Triage lead handover',
            kind: 'named'
          }
        }
      })
    ).toBe('Triage lead handover')
  })
})

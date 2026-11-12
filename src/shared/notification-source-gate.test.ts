import { describe, expect, it } from 'vitest'
import { getDefaultNotificationSettings } from './notification-settings-defaults'
import { isNotificationSourceEnabled } from './notification-source-gate'

describe('question-only notification delivery', () => {
  const questionsOnly = {
    ...getDefaultNotificationSettings(),
    agentQuestionsOnly: true,
    agentNeedsInput: false,
    agentTaskComplete: true,
    terminalBell: true
  }

  it.each([
    'AskUserQuestion',
    'ask_user_question',
    'request_user_input',
    'request_user_input_async'
  ])('delivers a pending %s question regardless of the retained source toggles', (tool) => {
    expect(isNotificationSourceEnabled(questionsOnly, 'agent-task-complete', 'waiting', tool)).toBe(
      true
    )
  })

  it.each([
    ['agent-task-complete', 'blocked', 'Bash'],
    ['agent-task-complete', 'waiting', undefined],
    ['agent-task-complete', 'done', 'AskUserQuestion'],
    ['agent-task-complete', 'working', 'AskUserQuestion'],
    ['terminal-bell', undefined, undefined]
  ])('mutes %s / %s / %s', (source, state, tool) => {
    expect(
      isNotificationSourceEnabled({ ...questionsOnly, agentNeedsInput: true }, source!, state, tool)
    ).toBe(false)
  })

  it('preserves ordinary permission alerts when the mode is off and the master mute when on', () => {
    expect(
      isNotificationSourceEnabled(
        questionsOnly,
        'agent-task-complete',
        'blocked',
        'AskUserQuestion'
      )
    ).toBe(true)
    expect(
      isNotificationSourceEnabled(
        getDefaultNotificationSettings(),
        'agent-task-complete',
        'blocked',
        'Bash'
      )
    ).toBe(true)
    expect(
      isNotificationSourceEnabled(
        { ...questionsOnly, enabled: false },
        'agent-task-complete',
        'waiting',
        'AskUserQuestion'
      )
    ).toBe(false)
    expect(isNotificationSourceEnabled(questionsOnly, 'test', undefined)).toBe(true)
  })
})

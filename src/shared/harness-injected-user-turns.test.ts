import { describe, expect, it } from 'vitest'

import { isHarnessInjectedUserTurnText } from './harness-injected-user-turns'

describe('isHarnessInjectedUserTurnText', () => {
  it('matches harness machinery turns by prefix', () => {
    expect(
      isHarnessInjectedUserTurnText(
        '<task-notification> <task-id>bzthj2b8r</task-id> <tool-use-id>toolu_01abc</tool-use-id>'
      )
    ).toBe(true)
    expect(isHarnessInjectedUserTurnText('<system-reminder>context</system-reminder>')).toBe(true)
    expect(isHarnessInjectedUserTurnText('<command-name>/review</command-name>')).toBe(true)
    expect(isHarnessInjectedUserTurnText('<local-command-stdout>ok</local-command-stdout>')).toBe(
      true
    )
    expect(isHarnessInjectedUserTurnText('[Request interrupted by user]')).toBe(true)
    expect(
      isHarnessInjectedUserTurnText('This session is being continued from a previous conversation.')
    ).toBe(true)
  })

  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(isHarnessInjectedUserTurnText('  <TASK-NOTIFICATION> done')).toBe(true)
    expect(isHarnessInjectedUserTurnText('\n<System-Reminder> hi')).toBe(true)
  })

  it('keeps real user prompts, including ones that mention the tags', () => {
    expect(isHarnessInjectedUserTurnText('fix the login bug')).toBe(false)
    expect(isHarnessInjectedUserTurnText('why does <task-notification> show in the sidebar?')).toBe(
      false
    )
    expect(isHarnessInjectedUserTurnText('')).toBe(false)
    expect(isHarnessInjectedUserTurnText('   ')).toBe(false)
  })
})

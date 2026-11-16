import { describe, expect, it } from 'vitest'

import { isKnownHarnessInjectedUserTurnText } from './harness-injected-user-turns'

describe('isKnownHarnessInjectedUserTurnText', () => {
  it('keeps real user prompts, including ones that mention the tags', () => {
    expect(isKnownHarnessInjectedUserTurnText('fix the login bug')).toBe(false)
    expect(
      isKnownHarnessInjectedUserTurnText('why does <task-notification> show in the sidebar?')
    ).toBe(false)
    expect(isKnownHarnessInjectedUserTurnText('')).toBe(false)
    expect(isKnownHarnessInjectedUserTurnText('   ')).toBe(false)
  })

  it('keeps single-word tag pastes, custom elements, and underscore wrappers', () => {
    // Grok wraps REAL typed prompts in <user_query> — never classify as noise.
    expect(isKnownHarnessInjectedUserTurnText('<user_query>fix the bug</user_query>')).toBe(false)
    expect(isKnownHarnessInjectedUserTurnText('<div class="x">pasted html</div>')).toBe(false)
    expect(
      isKnownHarnessInjectedUserTurnText('<script>alert(1)</script> — why is this flagged?')
    ).toBe(false)
    expect(isKnownHarnessInjectedUserTurnText('<https://example.com/a-b> what is this?')).toBe(
      false
    )
    expect(isKnownHarnessInjectedUserTurnText('<foo-bar@example.com> sent me this')).toBe(false)
  })

  it('does not treat unknown kebab tags as machinery', () => {
    // Only catalogued harness tags are noise; unknown/custom elements remain user input.
    expect(isKnownHarnessInjectedUserTurnText('<my-custom-element>pasted code')).toBe(false)
    expect(isKnownHarnessInjectedUserTurnText('<brand-new-harness-tag id="1">payload')).toBe(false)
    expect(isKnownHarnessInjectedUserTurnText('<queued-notice>\nlater')).toBe(false)
  })

  it('only treats the attributed <channel source=…> form as machinery', () => {
    // Only attributed channel source tags are machinery; bare channel is legitimate RSS/XML input.
    expect(isKnownHarnessInjectedUserTurnText('<channel source="general">new post')).toBe(true)
    expect(
      isKnownHarnessInjectedUserTurnText('<channel>general</channel> explain this feed element')
    ).toBe(false)
  })
})

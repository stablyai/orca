import { describe, expect, it } from 'vitest'
import { buildBranchNamePrompt } from './branch-name-from-work'

describe('buildBranchNamePrompt', () => {
  it('uses the task after harness envelopes without changing custom naming guidance', () => {
    const prompt = buildBranchNamePrompt(
      {
        firstPrompt:
          '<system-reminder>context</system-reminder>\n<hook_result hook_event="UserPromptSubmit">{}</hook_result>\nFix CI config'
      },
      'Use a fix/ prefix'
    )

    expect(prompt).toContain('User request:\nFix CI config')
    expect(prompt).toContain('Use a fix/ prefix')
    expect(prompt).not.toContain('hook_result')
    expect(prompt).not.toContain('system-reminder')
  })
})

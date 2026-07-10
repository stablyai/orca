import { describe, expect, it } from 'vitest'
import {
  appendPushFailureCustomInstruction,
  buildFixPushFailurePrompt
} from '../../../../shared/source-control-push-failure'
import { buildPushFailureAgentCommandInput } from '../../../../shared/source-control-push-failure-agent-command'

describe('SourceControl push failure recovery prompt', () => {
  it('leaves blank launch templates blank so the launcher can reject them', () => {
    expect(
      buildPushFailureAgentCommandInput({
        commandInputTemplate: '   ',
        basePrompt: 'Fix this push failure.'
      })
    ).toBe('')
  })

  it('falls back to the base push-failure prompt when no launch template is saved', () => {
    expect(
      buildPushFailureAgentCommandInput({
        commandInputTemplate: undefined,
        basePrompt: 'Fix this push failure.'
      })
    ).toBe('Fix this push failure.')
  })

  it('adds one-time custom instructions before the response contract', () => {
    const prompt = buildFixPushFailurePrompt({
      summary: 'Pre-push hook failed.',
      error: 'lint failed',
      branchName: 'main',
      worktreePath: null,
      entries: [],
      customInstruction: 'Only change TypeScript files.'
    })

    expect(prompt).toContain('Additional user instruction for this fix:')
    expect(prompt).toContain('Only change TypeScript files.')
    expect(prompt.trim().endsWith('anything left for the user.')).toBe(true)
  })

  it('leaves the base prompt unchanged for empty custom instructions', () => {
    const prompt = 'Fix the failed push.'
    expect(appendPushFailureCustomInstruction(prompt, '   ')).toBe(prompt)
  })
})

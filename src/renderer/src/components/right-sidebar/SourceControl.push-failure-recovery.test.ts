import { describe, expect, it } from 'vitest'
import {
  appendPushFailureCustomInstruction,
  buildFixPushFailurePrompt
} from '../../../../shared/source-control-push-failure'

describe('SourceControl push failure recovery prompt', () => {
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

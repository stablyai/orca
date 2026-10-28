import { describe, expect, it } from 'vitest'
import {
  planSourceControlCommitMessageGeneration,
  planSourceControlTextGeneration
} from './source-control-generation-plan'

describe('planSourceControlCommitMessageGeneration', () => {
  it('rejects command templates that render empty input', () => {
    expect(
      planSourceControlCommitMessageGeneration({
        agentId: 'codex',
        model: 'gpt-5.5',
        commandInputTemplate: ''
      })
    ).toEqual({ ok: false, error: 'Command input is empty.' })
  })

  it('expands linkedIssue when validating commit and pull-request recipes', () => {
    for (const actionId of ['commitMessage', 'pullRequest'] as const) {
      // Why: `{prompt}` puts the rendered template in argv, so commandLabel shows it.
      const result = planSourceControlTextGeneration(actionId, {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'echo {prompt}',
        commandInputTemplate: 'Fixes #{linkedIssue}'
      })

      expect(result.ok && result.commandLabel).toBe('echo Fixes #123')
    }
  })

  it('accepts a bare {linkedIssue} recipe, which is only empty per workspace', () => {
    // Saved repo/global recipes must validate independently of active-workspace linkage.
    const result = planSourceControlTextGeneration('commitMessage', {
      agentId: 'custom',
      model: '',
      customAgentCommand: 'echo {prompt}',
      commandInputTemplate: '{linkedIssue}'
    })

    expect(result).toEqual(expect.objectContaining({ ok: true, commandLabel: 'echo 123' }))
  })

  it('leaves linkedIssue literal when validating branch-name recipes', () => {
    const result = planSourceControlTextGeneration('branchName', {
      agentId: 'custom',
      model: '',
      customAgentCommand: 'echo {prompt}',
      commandInputTemplate: 'issue {linkedIssue}'
    })

    expect(result.ok && result.commandLabel).toBe('echo issue {linkedIssue}')
  })
})

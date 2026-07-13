import { describe, expect, it } from 'vitest'

import { buildCommitFailureAgentCommandInput } from './source-control-commit-failure-agent-command'
import { buildPushFailureAgentCommandInput } from './source-control-push-failure-agent-command'
import { buildSourceControlRecoveryAgentCommandInput } from './source-control-recovery-agent-command'

describe('source-control recovery agent command input', () => {
  it('renders a generic recovery command template for a launch action', () => {
    expect(
      buildSourceControlRecoveryAgentCommandInput({
        actionId: 'fixPushFailure',
        commandInputTemplate: 'agent {basePrompt}',
        basePrompt: 'Fix this push failure.'
      })
    ).toBe('agent Fix this push failure.')
  })

  it('leaves blank templates blank so the launcher can reject them', () => {
    expect(
      buildSourceControlRecoveryAgentCommandInput({
        actionId: 'fixCommitFailure',
        commandInputTemplate: '   ',
        basePrompt: 'Fix this commit failure.'
      })
    ).toBe('')
  })

  it('uses prompt overrides before saved templates', () => {
    expect(
      buildSourceControlRecoveryAgentCommandInput({
        actionId: 'fixCommitFailure',
        promptOverride: '  custom prompt  ',
        commandInputTemplate: '{basePrompt}',
        basePrompt: 'Fix this commit failure.'
      })
    ).toBe('custom prompt')
  })

  it('keeps commit and push compatibility wrappers on the generic builder', () => {
    expect(
      buildCommitFailureAgentCommandInput({
        commandInputTemplate: undefined,
        basePrompt: 'Fix this commit failure.'
      })
    ).toBe('Fix this commit failure.')
    expect(
      buildPushFailureAgentCommandInput({
        commandInputTemplate: undefined,
        basePrompt: 'Fix this push failure.'
      })
    ).toBe('Fix this push failure.')
  })
})

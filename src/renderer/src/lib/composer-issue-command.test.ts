import { describe, expect, it } from 'vitest'
import {
  buildTrustedComposerIssueCommand,
  shouldPrepareComposerIssueCommand
} from './composer-issue-command'

const readyInput = {
  enabled: true,
  provider: 'github' as const,
  issueNumber: 42,
  template: 'gh issue view {{issue}} --repo {{artifact_url}}',
  artifactUrl: 'https://github.com/stablyai/orca/issues/42'
}

describe('composer issue command', () => {
  it('renders a trusted GitHub issue command', () => {
    expect(buildTrustedComposerIssueCommand({ ...readyInput, trustDecision: 'run' })).toEqual({
      command: 'gh issue view 42 --repo https://github.com/stablyai/orca/issues/42'
    })
  })

  it('skips untrusted, disabled, PR, and empty commands', () => {
    expect(
      buildTrustedComposerIssueCommand({ ...readyInput, trustDecision: 'skip' })
    ).toBeUndefined()
    expect(shouldPrepareComposerIssueCommand({ ...readyInput, enabled: false })).toBe(false)
    expect(shouldPrepareComposerIssueCommand({ ...readyInput, issueNumber: null })).toBe(false)
    expect(shouldPrepareComposerIssueCommand({ ...readyInput, template: '   ' })).toBe(false)
  })
})

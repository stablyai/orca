import { describe, expect, it } from 'vitest'
import { branchAutoRenameFailureReason } from './branch-auto-rename-failure-reason'

describe('branchAutoRenameFailureReason', () => {
  it('reads persisted errors from any build into one plain reason', () => {
    const cases: [string, ReturnType<typeof branchAutoRenameFailureReason>][] = [
      // Stored by builds before the Codex refusal retry: raw CLI excerpt.
      [
        "Codex CLI command failed with code 1: Reading prompt from stdin... OpenAI Codex v0.165.0 … ERROR: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
        { kind: 'model-unavailable', model: 'gpt-5.5', agent: 'Codex', accountTier: true }
      ],
      [
        'Model "gpt-5.5" is not available for Codex.',
        { kind: 'model-unavailable', model: 'gpt-5.5', agent: 'Codex', accountTier: false }
      ],
      ['Generation timed out after 60s.', { kind: 'timed-out', seconds: 60 }],
      [
        'codex not found on PATH. Install Codex to use AI commit messages.',
        { kind: 'agent-missing', agent: 'Codex' }
      ],
      [
        'Claude CLI command failed with code 1: You have hit your usage limit.',
        { kind: 'usage-limit', agent: 'Claude' }
      ],
      [
        'Claude CLI command failed with code 1: Invalid API key · Please run /login',
        { kind: 'signed-out', agent: 'Claude' }
      ],
      ['Claude CLI command failed with code 2.', { kind: 'agent-failed', agent: 'Claude' }],
      [
        'Could not check whether the branch is published: fatal: not a git repository',
        { kind: 'publish-check' }
      ],
      ['Could not prepare the branch-name generation environment.', { kind: 'environment' }],
      ['Command template is empty for branch names.', { kind: 'no-agent' }],
      ['Generated branch name was empty after sanitization.', { kind: 'empty-name' }],
      ['something nobody anticipated', { kind: 'unknown' }]
    ]
    for (const [error, reason] of cases) {
      expect(branchAutoRenameFailureReason(error), error).toEqual(reason)
    }
  })
})

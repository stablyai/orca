import { describe, expect, it } from 'vitest'
import { planCommitMessageGeneration } from './commit-message-plan'

describe('planCommitMessageGeneration', () => {
  it('plans Claude non-interactive generation with the prompt on stdin only', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'claude',
        model: 'claude-sonnet-4-6',
        thinkingLevel: 'high'
      },
      'PROMPT'
    )

    expect(result).toEqual({
      ok: true,
      plan: {
        binary: 'claude',
        args: ['-p', '--output-format', 'text', '--model', 'claude-sonnet-4-6', '--effort', 'high'],
        stdinPayload: 'PROMPT',
        label: 'Claude'
      }
    })
  })

  it('plans Codex exec as non-interactive read-only generation with the prompt on stdin only', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'codex',
        model: 'gpt-5.4-mini',
        thinkingLevel: 'medium'
      },
      'PROMPT'
    )

    expect(result).toEqual({
      ok: true,
      plan: {
        binary: 'codex',
        args: [
          'exec',
          '--ephemeral',
          '--skip-git-repo-check',
          '-s',
          'read-only',
          '--model',
          'gpt-5.4-mini',
          '-c',
          'model_reasoning_effort=medium'
        ],
        stdinPayload: 'PROMPT',
        label: 'Codex'
      }
    })
  })

  it('uses preset agent command overrides as the spawn command prefix', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'codex',
        model: 'gpt-5.4-mini',
        agentCommandOverride: 'npx codex'
      },
      'PROMPT'
    )

    expect(result).toMatchObject({
      ok: true,
      plan: {
        binary: 'npx',
        args: [
          'codex',
          'exec',
          '--ephemeral',
          '--skip-git-repo-check',
          '-s',
          'read-only',
          '--model',
          'gpt-5.4-mini'
        ],
        stdinPayload: 'PROMPT'
      }
    })
  })

  it('rejects invalid preset agent command overrides before spawning', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'claude',
        model: 'claude-haiku-4-5',
        agentCommandOverride: 'claude "unterminated'
      },
      'PROMPT'
    )

    expect(result).toEqual({
      ok: false,
      error: 'Agent command override is invalid: Unclosed quote in command template.'
    })
  })
})

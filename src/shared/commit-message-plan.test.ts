import { describe, expect, it } from 'vitest'
import { planCommitMessageGeneration, planAgentBinary } from './commit-message-plan'

describe('planCommitMessageGeneration', () => {
  it('keeps extension-provided Pi models available in generated Git text plans', () => {
    const result = planCommitMessageGeneration(
      { agentId: 'pi', model: 'local-extension/model' },
      'Write a commit message'
    )
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.plan.args).not.toContain('--no-extensions')
    expect(result.plan.args).toEqual(
      expect.arrayContaining([
        '--no-session',
        '--no-tools',
        '--no-skills',
        '--no-context-files',
        '--model',
        'local-extension/model'
      ])
    )
    expect(result.plan.stdinPayload).toBe('Write a commit message')
  })

  it('plans Claude non-interactive generation with the prompt on stdin only', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'claude',
        model: 'sonnet',
        thinkingLevel: 'high'
      },
      'PROMPT'
    )

    expect(result).toEqual({
      ok: true,
      plan: {
        binary: 'claude',
        args: [
          '-p',
          '--output-format',
          'text',
          '--model',
          'sonnet',
          '--permission-mode',
          'plan',
          '--effort',
          'high',
          '--strict-mcp-config',
          '--settings',
          '{"disableAllHooks":true}'
        ],
        stdinPayload: 'PROMPT',
        label: 'Claude'
      }
    })
  })

  it('preserves a literal --settings prompt value without generating hooks settings', () => {
    const result = planCommitMessageGeneration(
      { agentId: 'claude', model: 'sonnet', agentArgs: '--append-system-prompt "--settings"' },
      'PROMPT'
    )
    expect(result.ok && result.plan.args.slice(-3)).toEqual([
      '--strict-mcp-config',
      '--append-system-prompt',
      '--settings'
    ])
    expect(result.ok && result.plan.args).not.toContain('{"disableAllHooks":true}')
  })

  it('plans OpenCode run with prompt on stdin and model variant', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'opencode',
        model: 'opencode/gpt-5.4-mini',
        thinkingLevel: 'high'
      },
      'PROMPT'
    )

    expect(result).toEqual({
      ok: true,
      plan: {
        binary: 'opencode',
        args: [
          'run',
          '--model',
          'opencode/gpt-5.4-mini',
          '--agent',
          'build',
          '--format',
          'json',
          '--variant',
          'high'
        ],
        stdinPayload: 'PROMPT',
        label: 'OpenCode',
        outputFormat: 'opencode-json'
      }
    })
  })

  it('keeps OpenCode preset command overrides while sending the prompt on stdin', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'opencode',
        model: 'opencode/gpt-5.4-mini',
        agentCommandOverride: 'npx opencode'
      },
      'PROMPT'
    )

    expect(result).toEqual({
      ok: true,
      plan: {
        binary: 'npx',
        args: [
          'opencode',
          'run',
          '--model',
          'opencode/gpt-5.4-mini',
          '--agent',
          'build',
          '--format',
          'json'
        ],
        stdinPayload: 'PROMPT',
        label: 'OpenCode',
        outputFormat: 'opencode-json'
      }
    })
  })

  it('plans Amp execute generation without the removed archive flag', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'amp',
        model: 'large',
        thinkingLevel: 'medium'
      },
      'PROMPT'
    )

    expect(result).toEqual({
      ok: true,
      plan: {
        binary: 'amp',
        args: [
          '--execute',
          '--no-notifications',
          '--no-ide',
          '--no-jetbrains',
          '--mode',
          'large',
          '--effort',
          'medium'
        ],
        stdinPayload: 'PROMPT',
        label: 'Amp'
      }
    })
  })

  it('plans Jcode run generation with an argv prompt', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'jcode',
        model: 'default'
      },
      'name this branch'
    )

    expect(result).toEqual({
      ok: true,
      plan: {
        binary: 'jcode',
        // Staged patches must not inherit jcode’s default shell/read/write/MCP tools.
        args: [
          '--no-update',
          '--quiet',
          '--no-selfdev',
          '--tool-profile',
          'none',
          'run',
          '--json',
          'name this branch'
        ],
        stdinPayload: null,
        label: 'Jcode'
      }
    })
  })

  it('allows discovered dynamic models that are not in the seed catalog', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'cursor',
        model: 'gpt-5.2',
        thinkingLevel: 'xhigh'
      },
      'PROMPT'
    )

    expect(result).toEqual({
      ok: true,
      plan: {
        binary: 'cursor-agent',
        args: [
          '--print',
          '--mode',
          'ask',
          '--trust',
          '--output-format',
          'text',
          '--model',
          'gpt-5.2',
          'PROMPT'
        ],
        stdinPayload: null,
        label: 'Cursor'
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

  it('plans Muse exec with a positional prompt and no workspace side effects', () => {
    const result = planCommitMessageGeneration({ agentId: 'muse', model: 'default' }, 'PROMPT')

    expect(result).toEqual({
      ok: true,
      plan: {
        binary: 'muse',
        args: [
          'exec',
          '--no-session-log',
          '--approval-mode',
          'never',
          '--disable-sandbox',
          '--disable-shell',
          '--disable-write',
          '--disable-web-tools',
          '--',
          'PROMPT'
        ],
        stdinPayload: null,
        label: 'Muse'
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

  it.each([
    ['long option', '--model gpt-5.6-luna', ['--model', 'gpt-5.6-luna'], []],
    ['short option', '-m gpt-5.6-luna', ['-m', 'gpt-5.6-luna'], []],
    ['equals form', '--model=gpt-5.6-luna', ['--model=gpt-5.6-luna'], []],
    ['attached short form', '-mgpt-5.6-luna', ['-mgpt-5.6-luna'], []],
    [
      'sibling arguments',
      '--model gpt-5.6-luna --sandbox read-only',
      ['--model', 'gpt-5.6-luna'],
      ['--sandbox', 'read-only']
    ]
  ])(
    'lets Codex recipe args override the generated model via %s',
    (_, agentArgs, overrideArgs, trailingArgs) => {
      const result = planCommitMessageGeneration(
        { agentId: 'codex', model: 'gpt-5.4-mini', thinkingLevel: 'medium', agentArgs },
        'PROMPT'
      )

      expect(result).toMatchObject({
        ok: true,
        plan: {
          args: [
            'exec',
            '--ephemeral',
            '--skip-git-repo-check',
            '-s',
            'read-only',
            ...overrideArgs,
            '-c',
            'model_reasoning_effort=medium',
            ...trailingArgs
          ],
          stdinPayload: 'PROMPT'
        }
      })
    }
  )

  it('keeps Codex recipe arguments unchanged when they do not override the model', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'codex',
        model: 'gpt-5.4-mini',
        agentArgs: '--sandbox workspace-write'
      },
      'PROMPT'
    )

    expect(result).toMatchObject({
      ok: true,
      plan: {
        args: [
          'exec',
          '--ephemeral',
          '--skip-git-repo-check',
          '-s',
          'read-only',
          '--model',
          'gpt-5.4-mini',
          '--sandbox',
          'workspace-write'
        ]
      }
    })
  })

  it('keeps the generated Codex model when model-like text follows an option terminator', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'codex',
        model: 'gpt-5.4-mini',
        agentArgs: '-- --model literal'
      },
      'PROMPT'
    )

    expect(result).toMatchObject({
      ok: true,
      plan: {
        args: [
          'exec',
          '--ephemeral',
          '--skip-git-repo-check',
          '-s',
          'read-only',
          '--model',
          'gpt-5.4-mini',
          '--',
          '--model',
          'literal'
        ]
      }
    })
  })

  it('lets OpenCode recipe args override the generated model instead of repeating it', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'opencode',
        model: 'opencode/gpt-5.4-mini',
        agentArgs: '--model opencode/gpt-5.5'
      },
      'PROMPT'
    )

    expect(result).toMatchObject({
      ok: true,
      plan: {
        args: ['run', '--model', 'opencode/gpt-5.5', '--agent', 'build', '--format', 'json'],
        stdinPayload: 'PROMPT'
      }
    })
  })

  it('overrides the generated OpenCode model from a short-form recipe alias', () => {
    const result = planCommitMessageGeneration(
      { agentId: 'opencode', model: 'opencode/gpt-5.4-mini', agentArgs: '-m opencode/gpt-5.5' },
      'PROMPT'
    )

    expect(result).toMatchObject({
      ok: true,
      plan: {
        args: ['run', '-m', 'opencode/gpt-5.5', '--agent', 'build', '--format', 'json']
      }
    })
  })

  it('overrides OpenCode singleton flags beyond the model', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'opencode',
        model: 'opencode/gpt-5.4-mini',
        thinkingLevel: 'high',
        agentArgs: '--agent plan --format json --variant low'
      },
      'PROMPT'
    )

    expect(result).toMatchObject({
      ok: true,
      plan: {
        args: [
          'run',
          '--model',
          'opencode/gpt-5.4-mini',
          '--agent',
          'plan',
          '--format',
          'json',
          '--variant',
          'low'
        ]
      }
    })
  })

  it('appends per-action CLI arguments that do not repeat a generated OpenCode flag', () => {
    const result = planCommitMessageGeneration(
      { agentId: 'opencode', model: 'opencode/gpt-5.4-mini', agentArgs: '--share' },
      'PROMPT'
    )

    expect(result).toMatchObject({
      ok: true,
      plan: {
        args: [
          'run',
          '--model',
          'opencode/gpt-5.4-mini',
          '--agent',
          'build',
          '--format',
          'json',
          '--share'
        ],
        stdinPayload: 'PROMPT'
      }
    })
  })

  it('collapses a singleton flag the user typed twice in one field', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'opencode',
        model: 'opencode/gpt-5.4-mini',
        agentArgs: '--model opencode/first -m opencode/second'
      },
      'PROMPT'
    )

    expect(result).toMatchObject({
      ok: true,
      plan: {
        args: ['run', '--model', 'opencode/first', '--agent', 'build', '--format', 'json']
      }
    })
  })

  it('overrides the generated Amp mode rather than repeating it', () => {
    const result = planCommitMessageGeneration(
      { agentId: 'amp', model: 'smart', agentArgs: '--mode rush' },
      'PROMPT'
    )

    expect(result).toMatchObject({
      ok: true,
      plan: {
        args: ['--execute', '--no-notifications', '--no-ide', '--no-jetbrains', '--mode', 'rush']
      }
    })
  })

  it('keeps a model flag in the agent command override and removes the generated duplicate', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'opencode',
        model: 'opencode/gpt-5.4-mini',
        agentCommandOverride: 'npx opencode --model opencode/gpt-5.5 --log-level DEBUG'
      },
      'PROMPT'
    )

    expect(result).toMatchObject({
      ok: true,
      plan: {
        binary: 'npx',
        args: [
          'opencode',
          '--model',
          'opencode/gpt-5.5',
          '--log-level',
          'DEBUG',
          'run',
          '--agent',
          'build',
          '--format',
          'json'
        ]
      }
    })
  })

  it('does not move command override options across an option terminator', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'opencode',
        model: 'opencode/gpt-5.4-mini',
        agentCommandOverride: 'opencode --model opencode/from-override -- --model literal'
      },
      'PROMPT'
    )

    expect(result).toMatchObject({
      ok: true,
      plan: {
        args: [
          '--model',
          'opencode/from-override',
          '--',
          '--model',
          'literal',
          'run',
          '--model',
          'opencode/gpt-5.4-mini',
          '--agent',
          'build',
          '--format',
          'json'
        ]
      }
    })
  })

  it('lets recipe args outrank a command override that also sets the model', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'opencode',
        model: 'opencode/gpt-5.4-mini',
        agentCommandOverride: 'opencode --model opencode/from-override',
        agentArgs: '--model opencode/from-recipe'
      },
      'PROMPT'
    )

    expect(result).toMatchObject({
      ok: true,
      plan: {
        binary: 'opencode',
        args: ['run', '--model', 'opencode/from-recipe', '--agent', 'build', '--format', 'json']
      }
    })
  })

  it('keeps custom per-action CLI arguments before a positional prompt', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent --message {prompt}',
        agentArgs: '--model gpt-5.5'
      },
      'PROMPT'
    )

    expect(result).toEqual({
      ok: true,
      plan: {
        binary: 'agent',
        args: ['--message', '--model', 'gpt-5.5', 'PROMPT'],
        stdinPayload: null,
        label: 'agent'
      }
    })
  })

  it('appends custom per-action CLI arguments when the prompt is sent on stdin', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent --message',
        agentArgs: '--model gpt-5.5'
      },
      'PROMPT'
    )

    expect(result).toMatchObject({
      ok: true,
      plan: {
        args: ['--message', '--model', 'gpt-5.5'],
        stdinPayload: 'PROMPT'
      }
    })
  })

  it('rejects invalid per-action CLI arguments before spawning', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'claude',
        model: 'haiku',
        agentArgs: '--model "unterminated'
      },
      'PROMPT'
    )

    expect(result).toEqual({
      ok: false,
      error: 'CLI arguments are invalid: Unclosed quote in command template.'
    })
  })

  it('rejects invalid preset agent command overrides before spawning', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'claude',
        model: 'haiku',
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

describe('backslash mode reaches every command the user can type (#11375)', () => {
  const WINDOWS_BINARY = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

  it('keeps an agent command override intact in literal mode', () => {
    const posix = planAgentBinary('claude', WINDOWS_BINARY)
    const literal = planAgentBinary('claude', WINDOWS_BINARY, 'literal')

    // The bug: POSIX escaping eats every separator, so the binary is not found.
    expect(posix.ok && posix.binary).toBe('C:WindowsSystem32WindowsPowerShellv1.0powershell.exe')
    expect(literal.ok && literal.binary).toBe(WINDOWS_BINARY)
  })

  it('keeps a quoted path containing spaces intact in literal mode', () => {
    const literal = planAgentBinary('claude', '"C:\\Program Files\\nodejs\\node.exe"', 'literal')

    expect(literal.ok && literal.binary).toBe('C:\\Program Files\\nodejs\\node.exe')
  })

  it('keeps extra CLI args intact through planCommitMessageGeneration', () => {
    const plan = planCommitMessageGeneration(
      {
        agentId: 'claude',
        model: 'sonnet',
        agentCommandOverride: WINDOWS_BINARY,
        agentArgs: '--config C:\\Users\\me\\.claude.json',
        backslash: 'literal'
      },
      'prompt'
    )

    expect(plan.ok && plan.plan.binary).toBe(WINDOWS_BINARY)
    expect(plan.ok && plan.plan.args).toContain('C:\\Users\\me\\.claude.json')
  })

  it('defaults to POSIX escaping when no mode is given', () => {
    const plan = planCommitMessageGeneration(
      { agentId: 'claude', model: 'sonnet', agentArgs: '--dir /my\\ dir' },
      'prompt'
    )

    expect(plan.ok && plan.plan.args).toContain('/my dir')
  })
})

describe('OpenCode format metadata respects option terminators', () => {
  it.each(['opencode', 'opencode2'] as const)(
    'ignores literal recipe format values for %s',
    (agentId) => {
      const result = planCommitMessageGeneration(
        {
          agentId,
          model: 'opencode/gpt-5.4-mini',
          agentArgs: '--format default -- --format json'
        },
        'PROMPT'
      )
      expect(result.ok).toBe(true)
      if (!result.ok) {
        throw new Error(result.error)
      }
      expect(result.plan.args).toContain('--')
      expect(result.plan.outputFormat).toBeUndefined()
    }
  )

  it('ignores literal equals-form flags after a command override terminator', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'opencode',
        model: 'opencode/gpt-5.4-mini',
        agentCommandOverride: 'opencode --format default -- --format=json'
      },
      'PROMPT'
    )
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.plan.outputFormat).toBeUndefined()
  })

  it('retains JSON metadata for the active option before a literal default value', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'opencode',
        model: 'opencode/gpt-5.4-mini',
        agentArgs: '--format=json -- --format default'
      },
      'PROMPT'
    )
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.plan.outputFormat).toBe('opencode-json')
  })
})

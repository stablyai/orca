import { describe, expect, it } from 'vitest'
import { planCommitMessageGeneration, planAgentBinary } from './commit-message-plan'

describe('planCommitMessageGeneration', () => {
  it('omits Pi model args only for valid configured-default intent', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'pi',
        model: 'github-copilot/gpt-5.4-mini',
        useConfiguredDefaultModel: true
      },
      'PROMPT'
    )

    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.plan.args).not.toContain('--model')
  })

  it('rejects configured-default intent for a non-Pi model', () => {
    expect(
      planCommitMessageGeneration(
        { agentId: 'codex', model: 'gpt-5.4', useConfiguredDefaultModel: true },
        'PROMPT'
      )
    ).toMatchObject({ ok: false })
  })

  it.each([
    { model: 'openai-codex/gpt-5.5' },
    { model: 'github-copilot/gpt-5.4-mini', thinkingLevel: 'medium' }
  ])('rejects invalid Pi configured-default params: $model $thinkingLevel', (params) => {
    expect(
      planCommitMessageGeneration(
        { agentId: 'pi', useConfiguredDefaultModel: true, ...params },
        'PROMPT'
      )
    ).toMatchObject({ ok: false })
  })

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
          'high'
        ],
        stdinPayload: 'PROMPT',
        label: 'Claude'
      }
    })
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
          'default',
          '--variant',
          'high'
        ],
        stdinPayload: 'PROMPT',
        label: 'OpenCode'
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
          'default'
        ],
        stdinPayload: 'PROMPT',
        label: 'OpenCode'
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

  it('plans Antigravity generation with the prompt attached to --print, not stdin (#19539, #14059)', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'antigravity',
        model: 'Gemini 3.5 Flash (Medium)'
      },
      'real commit prompt'
    )

    expect(result).toEqual({
      ok: true,
      plan: {
        binary: 'agy',
        args: ['--print=real commit prompt', '--sandbox', '--model', 'Gemini 3.5 Flash (Medium)'],
        stdinPayload: null,
        label: 'Antigravity'
      }
    })
  })

  it('keeps a leading-dash Antigravity prompt bound to --print instead of parsing as an option', () => {
    const result = planCommitMessageGeneration(
      { agentId: 'antigravity', model: 'Gemini 3.5 Flash (Medium)' },
      '-fix: something'
    )

    expect(result.ok).toBe(true)
    expect(result.ok && result.plan.args.slice(0, 2)).toEqual([
      '--print=-fix: something',
      '--sandbox'
    ])
  })

  // Why: pins argv construction only. Real agy 1.2.1 separately rejects a --print value
  // that exactly matches a registered flag name (its own heuristic, independent of this
  // fix) — verified `agy --print=--sandbox` still errors there. Real prompts are never
  // literally a bare flag name, so this doesn't affect actual generation.
  it('still glues an Antigravity prompt that collides with a flag name onto --print', () => {
    const result = planCommitMessageGeneration(
      { agentId: 'antigravity', model: 'Gemini 3.5 Flash (Medium)' },
      '--sandbox'
    )

    expect(result.ok).toBe(true)
    expect(result.ok && result.plan.args.slice(0, 2)).toEqual(['--print=--sandbox', '--sandbox'])
  })

  // Why: agy has no documented stdin mode for --print (#19539's body: "--print ... is
  // not a boolean flag that automatically reads from stdin; it expects the prompt
  // string as its option argument"), so a large staged patch now rides on argv. This
  // is the same unguarded argv delivery cursor/kimi/copilot already use (see the
  // parity assertion below) — pinned here as a known property, not a regression.
  it('puts a large Antigravity prompt on argv with no size guard, same as other argv-delivery agents', () => {
    const bigPrompt = 'y'.repeat(70_000)
    const result = planCommitMessageGeneration(
      { agentId: 'antigravity', model: 'Gemini 3.5 Flash (Medium)' },
      bigPrompt
    )

    expect(result.ok).toBe(true)
    expect(result.ok && result.plan.args[0]).toBe(`--print=${bigPrompt}`)
    expect(result.ok && result.plan.stdinPayload).toBeNull()

    const cursorResult = planCommitMessageGeneration(
      { agentId: 'cursor', model: 'auto' },
      bigPrompt
    )
    expect(cursorResult.ok).toBe(true)
    expect(cursorResult.ok && cursorResult.plan.args.at(-1)).toBe(bigPrompt)
    expect(cursorResult.ok && cursorResult.plan.stdinPayload).toBeNull()
  })

  // Why: real #14059 reproduction config — CLI arguments field repeats --model and adds
  // --add-dir/--effort/--dangerously-skip-permissions. Confirms none of it gets swallowed
  // into the --print operand and the duplicate --model is deduped the same way every
  // other spec's recipe args already are (DEFAULT_SINGLETON_OPTIONS, unaffected by
  // argument order).
  it('keeps #14059-style recipe CLI arguments intact and deduped around the print operand', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'antigravity',
        model: 'Gemini 3.5 Flash (Medium)',
        agentArgs:
          '--add-dir . --model gemini-3.6-flash --effort low --dangerously-skip-permissions'
      },
      'Generate a concise git commit message for the currently staged changes.'
    )

    expect(result).toEqual({
      ok: true,
      plan: {
        binary: 'agy',
        args: [
          '--print=Generate a concise git commit message for the currently staged changes.',
          '--sandbox',
          '--model',
          'gemini-3.6-flash',
          '--add-dir',
          '.',
          '--effort',
          'low',
          '--dangerously-skip-permissions'
        ],
        stdinPayload: null,
        label: 'Antigravity'
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
        args: ['run', '--model', 'opencode/gpt-5.5', '--agent', 'build', '--format', 'default'],
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
        args: ['run', '-m', 'opencode/gpt-5.5', '--agent', 'build', '--format', 'default']
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
          'default',
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
        args: ['run', '--model', 'opencode/first', '--agent', 'build', '--format', 'default']
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
          'default'
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
          'default'
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
        args: ['run', '--model', 'opencode/from-recipe', '--agent', 'build', '--format', 'default']
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

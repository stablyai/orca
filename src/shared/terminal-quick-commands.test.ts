import { describe, expect, it } from 'vitest'
import {
  applyTerminalQuickCommandMutation,
  buildQuickCommandSubmission,
  buildTerminalQuickCommandInput,
  flattenTerminalQuickCommand,
  getTerminalQuickCommandAction,
  getTerminalQuickCommandBody,
  getDefaultTerminalQuickCommands,
  isTerminalQuickCommandComplete,
  normalizeTerminalQuickCommands,
  parseNormalizedTerminalQuickCommands,
  supportsTerminalAgentQuickCommand,
  terminalQuickCommandMatchesRepo
} from './terminal-quick-commands'

describe('terminal quick commands', () => {
  it('returns safe defaults when persisted settings are missing', () => {
    expect(normalizeTerminalQuickCommands(undefined)).toEqual([])
    expect(getDefaultTerminalQuickCommands()).toEqual([])
  })

  it('keeps an intentionally empty command list', () => {
    expect(normalizeTerminalQuickCommands([])).toEqual([])
  })

  it('removes quick commands from the abandoned preset rollout', () => {
    expect(
      normalizeTerminalQuickCommands([
        {
          id: 'default-pwd',
          label: 'Print Working Directory',
          command: 'pwd',
          appendEnter: true
        },
        {
          id: 'default-git-status',
          label: 'Git Status',
          command: 'git status',
          appendEnter: true
        }
      ])
    ).toEqual([])
  })

  it('drops malformed entries and normalizes valid commands and drafts', () => {
    expect(
      normalizeTerminalQuickCommands([
        null,
        { id: 'status', label: '  Status  ', command: 'git status\n', appendEnter: false },
        { id: 'empty-command', label: 'Empty', command: '   ' },
        { id: 'status', label: 'Duplicate', command: 'pwd' },
        { label: 'No ID', command: 'date' }
      ])
    ).toEqual([
      {
        id: 'status',
        label: 'Status',
        action: 'terminal-command',
        command: 'git status',
        appendEnter: false,
        scope: { type: 'global' }
      },
      {
        id: 'empty-command',
        label: 'Empty',
        action: 'terminal-command',
        command: '',
        appendEnter: true,
        scope: { type: 'global' }
      },
      {
        id: 'status-2',
        label: 'Duplicate',
        action: 'terminal-command',
        command: 'pwd',
        appendEnter: true,
        scope: { type: 'global' }
      },
      {
        id: 'quick-command-4',
        label: 'No ID',
        action: 'terminal-command',
        command: 'date',
        appendEnter: true,
        scope: { type: 'global' }
      }
    ])
  })

  it('normalizes repository scoped commands and falls back to global for invalid scopes', () => {
    expect(
      normalizeTerminalQuickCommands([
        {
          id: 'repo-dev',
          label: 'Dev',
          command: 'pnpm dev',
          scope: { type: 'repo', repoId: ' repo-1 ' }
        },
        {
          id: 'bad-repo',
          label: 'Bad',
          command: 'echo bad',
          scope: { type: 'repo', repoId: '   ' }
        }
      ])
    ).toEqual([
      {
        id: 'repo-dev',
        label: 'Dev',
        action: 'terminal-command',
        command: 'pnpm dev',
        appendEnter: true,
        scope: { type: 'repo', repoId: 'repo-1' }
      },
      {
        id: 'bad-repo',
        label: 'Bad',
        action: 'terminal-command',
        command: 'echo bad',
        appendEnter: true,
        scope: { type: 'global' }
      }
    ])
  })

  it('normalizes agent prompt commands without storing generated shell text', () => {
    expect(
      normalizeTerminalQuickCommands([
        {
          id: 'agent-review',
          label: 'Review',
          action: 'agent-prompt',
          agent: 'codex',
          prompt: '  Review this diff\n',
          command: "codex 'old workaround'"
        },
        {
          id: 'unknown-agent',
          label: 'Unknown',
          action: 'agent-prompt',
          agent: 'not-real',
          prompt: 'Do work'
        },
        {
          id: 'post-start-agent',
          label: 'Aider',
          action: 'agent-prompt',
          agent: 'aider',
          prompt: 'Do work'
        }
      ])
    ).toEqual([
      {
        id: 'agent-review',
        label: 'Review',
        action: 'agent-prompt',
        agent: 'codex',
        prompt: '  Review this diff',
        scope: { type: 'global' }
      }
    ])
  })

  it('keeps larger reusable agent prompts while bounding shell commands separately', () => {
    const largePrompt = 'Review this diff.\n'.repeat(320)
    const overLimitPrompt = 'x'.repeat(6001)
    const overLimitCommand = 'y'.repeat(4001)

    expect(
      normalizeTerminalQuickCommands([
        {
          id: 'large-review',
          label: 'Review',
          action: 'agent-prompt',
          agent: 'codex',
          prompt: largePrompt
        },
        {
          id: 'over-limit-review',
          label: 'Review with cap',
          action: 'agent-prompt',
          agent: 'codex',
          prompt: overLimitPrompt
        },
        {
          id: 'over-limit-command',
          label: 'Run long command',
          command: overLimitCommand
        }
      ])
    ).toEqual([
      {
        id: 'large-review',
        label: 'Review',
        action: 'agent-prompt',
        agent: 'codex',
        prompt: largePrompt.trimEnd(),
        scope: { type: 'global' }
      },
      {
        id: 'over-limit-review',
        label: 'Review with cap',
        action: 'agent-prompt',
        agent: 'codex',
        prompt: 'x'.repeat(6000),
        scope: { type: 'global' }
      },
      {
        id: 'over-limit-command',
        label: 'Run long command',
        action: 'terminal-command',
        command: 'y'.repeat(4000),
        appendEnter: true,
        scope: { type: 'global' }
      }
    ])
  })

  it('accepts only complete canonical command lists at protocol boundaries', () => {
    const canonical = normalizeTerminalQuickCommands([
      { id: 'status', label: 'Status', command: 'git status', appendEnter: true }
    ])

    expect(parseNormalizedTerminalQuickCommands(canonical)).toEqual(canonical)
    expect(parseNormalizedTerminalQuickCommands([{ ...canonical[0], command: 42 }])).toBeNull()
    expect(
      parseNormalizedTerminalQuickCommands([...canonical, ...canonical.slice(0, 1)])
    ).toBeNull()
  })

  it('applies targeted mutations without replacing unrelated commands', () => {
    const [first, second] = normalizeTerminalQuickCommands([
      { id: 'first', label: 'First', command: 'echo first', appendEnter: true },
      { id: 'second', label: 'Second', command: 'echo second', appendEnter: true }
    ])
    const edited = { ...first!, label: 'Edited' }

    expect(
      applyTerminalQuickCommandMutation([first!, second!], {
        type: 'upsert',
        command: edited
      })
    ).toEqual([edited, second])
    expect(
      applyTerminalQuickCommandMutation([first!, second!], { type: 'delete', id: first!.id })
    ).toEqual([second])
  })

  it('matches global commands everywhere and repo commands only in their repo', () => {
    expect(
      terminalQuickCommandMatchesRepo(
        {
          id: 'global',
          label: 'Global',
          command: 'date',
          appendEnter: true,
          scope: { type: 'global' }
        },
        null
      )
    ).toBe(true)
    expect(
      terminalQuickCommandMatchesRepo(
        {
          id: 'repo',
          label: 'Repo',
          command: 'pnpm dev',
          appendEnter: true,
          scope: { type: 'repo', repoId: 'repo-1' }
        },
        'repo-1'
      )
    ).toBe(true)
    expect(
      terminalQuickCommandMatchesRepo(
        {
          id: 'repo',
          label: 'Repo',
          command: 'pnpm dev',
          appendEnter: true,
          scope: { type: 'repo', repoId: 'repo-1' }
        },
        'repo-2'
      )
    ).toBe(false)
  })

  it('formats terminal input without assuming shell semantics', () => {
    expect(
      buildTerminalQuickCommandInput({
        id: 'status',
        label: 'Status',
        command: 'git status',
        appendEnter: true
      })
    ).toBe('git status\r')
    expect(
      buildTerminalQuickCommandInput({
        id: 'status',
        label: 'Status',
        command: 'git status',
        appendEnter: false
      })
    ).toBe('git status')
  })

  it('wraps multiline terminal input in bracketed paste', () => {
    const command = 'echo one\necho two'
    expect(
      buildTerminalQuickCommandInput({
        id: 'multiline',
        label: 'Multiline',
        command,
        appendEnter: true
      })
    ).toBe(`\x1b[200~${command}\x1b[201~\r`)
    expect(
      buildTerminalQuickCommandInput(
        {
          id: 'insert',
          label: 'Insert',
          command,
          appendEnter: false
        },
        true
      )
    ).toBe(`\x1b[200~${command}\x1b[201~`)
    expect(
      buildTerminalQuickCommandInput(
        {
          id: 'insert',
          label: 'Insert',
          command,
          appendEnter: false
        },
        false
      )
    ).toBe(command)
  })

  describe('trailing newline preservation', () => {
    const commandWithTrailingLf = 'echo one\necho two\n'
    const pasteBody = `\x1b[200~${commandWithTrailingLf}\x1b[201~`

    it('existing-pane dispatch insert-only keeps trailing LF inside bracketed paste', () => {
      expect(
        buildTerminalQuickCommandInput(
          {
            id: 'insert',
            label: 'Insert',
            command: commandWithTrailingLf,
            appendEnter: false
          },
          true
        )
      ).toBe(pasteBody)
    })

    it('existing-pane dispatch run keeps trailing LF inside bracketed paste before submit', () => {
      expect(
        buildTerminalQuickCommandInput(
          {
            id: 'run',
            label: 'Run',
            command: commandWithTrailingLf,
            appendEnter: true
          },
          true
        )
      ).toBe(`${pasteBody}\r`)
    })

    it('new-tab startup keeps trailing LF inside bracketed paste', () => {
      expect(
        buildQuickCommandSubmission(commandWithTrailingLf, {
          submit: '\n',
          bracketedPasteSafe: true
        })
      ).toBe(`${pasteBody}\n`)
    })

    it('mobile shell-ready launch keeps trailing LF inside bracketed paste', () => {
      expect(
        buildQuickCommandSubmission(commandWithTrailingLf, {
          submit: '\r',
          bracketedPasteSafe: true
        })
      ).toBe(`${pasteBody}\r`)
    })

    it('bracketedPasteSafe false writes raw command without stripping trailing LF', () => {
      expect(
        buildQuickCommandSubmission(commandWithTrailingLf, {
          submit: '',
          bracketedPasteSafe: false
        })
      ).toBe(commandWithTrailingLf)
      expect(
        buildTerminalQuickCommandInput(
          {
            id: 'insert',
            label: 'Insert',
            command: commandWithTrailingLf,
            appendEnter: false
          },
          false
        )
      ).toBe(commandWithTrailingLf)
    })

    it('Windows non-bracketed quick command keeps body LF but submits with CR', () => {
      expect(
        buildQuickCommandSubmission('git status\n', {
          submit: '\r',
          bracketedPasteSafe: false
        })
      ).toBe('git status\r')
      expect(
        buildQuickCommandSubmission(commandWithTrailingLf, {
          submit: '\r',
          bracketedPasteSafe: false
        })
      ).toBe('echo one\necho two\r')
    })
  })

  it('classifies quick command actions and body text', () => {
    const terminal = {
      id: 'status',
      label: 'Status',
      command: 'git status',
      appendEnter: true
    }
    const agent = {
      id: 'agent',
      label: 'Agent',
      action: 'agent-prompt' as const,
      agent: 'claude' as const,
      prompt: 'Fix the tests'
    }

    expect(getTerminalQuickCommandAction(terminal)).toBe('terminal-command')
    expect(getTerminalQuickCommandBody(terminal)).toBe('git status')
    expect(isTerminalQuickCommandComplete(terminal)).toBe(true)
    expect(getTerminalQuickCommandAction(agent)).toBe('agent-prompt')
    expect(getTerminalQuickCommandBody(agent)).toBe('Fix the tests')
    expect(isTerminalQuickCommandComplete(agent)).toBe(true)
  })

  it('only allows agent prompt quick commands for launch-time prompt agents', () => {
    expect(supportsTerminalAgentQuickCommand('claude')).toBe(true)
    expect(supportsTerminalAgentQuickCommand('gemini')).toBe(true)
    expect(supportsTerminalAgentQuickCommand('aider')).toBe(false)
    expect(supportsTerminalAgentQuickCommand('not-real')).toBe(false)
  })
})

describe('flattenTerminalQuickCommand', () => {
  it('returns the same object when there are no line breaks', () => {
    const command = {
      id: 'test',
      label: 'Test',
      command: 'git status',
      appendEnter: true
    } as const
    expect(flattenTerminalQuickCommand(command)).toBe(command)
  })

  it('preserves newlines between independent shell statements', () => {
    const result = flattenTerminalQuickCommand({
      id: 'test',
      label: 'Test',
      command: 'cd packages\nbun run build\ncd ..',
      appendEnter: true
    })
    expect(result.command).toBe('cd packages\nbun run build\ncd ..')
    expect(result.command).not.toContain(';')
  })

  it('preserves multiline shell constructs without injecting semicolons', () => {
    const command = [
      'export ANDROID_SDK_ROOT="$ANDROID_HOME"',
      './gradlew -p PROJECT_DIR :MODULE:TASK --console=plain',
      '[ -f "$REPORT_FILE" ]',
      '|| open_status=$?'
    ].join('\n')
    const result = flattenTerminalQuickCommand({
      id: 'test',
      label: 'Test',
      command,
      appendEnter: true
    })
    expect(result.command).toBe(command)
    expect(result.command).not.toMatch(/export;/)
    expect(result.command).not.toMatch(/PROJECT_DIR;/)
    expect(result.command).not.toMatch(/\[ -f;/)
    expect(result.command).not.toMatch(/\|\|;/)
  })

  it('preserves backslash line continuations', () => {
    const command = 'orca tab create \\\n  --worktree WORKTREE \\\n  --url URL \\\n  --json'
    const result = flattenTerminalQuickCommand({
      id: 'test',
      label: 'Test',
      command,
      appendEnter: true
    })
    expect(result.command).toBe(command)
    expect(result.command).not.toContain('\\;')
  })

  it('preserves subshell scripts with if conditions', () => {
    const command = [
      '(',
      '  value="hello"',
      '  if [ -n "$value" ]; then',
      '    printf \'%s\\n\' "$value"',
      '  fi',
      ')'
    ].join('\n')
    const result = flattenTerminalQuickCommand({
      id: 'test',
      label: 'Test',
      command,
      appendEnter: true
    })
    expect(result.command).toBe(command)
    expect(result.command).not.toMatch(/if \[ -n;/)
  })

  it('normalizes Windows-style CRLF endings to LF', () => {
    const result = flattenTerminalQuickCommand({
      id: 'test',
      label: 'Test',
      command: 'echo one\r\necho two',
      appendEnter: true
    })
    expect(result.command).toBe('echo one\necho two')
  })

  it('preserves blank lines and indentation inside multiline commands', () => {
    const command = '\n  echo one  \n\n  echo two\n'
    const result = flattenTerminalQuickCommand({
      id: 'test',
      label: 'Test',
      command,
      appendEnter: true
    })
    expect(result.command).toBe(command)
  })
})

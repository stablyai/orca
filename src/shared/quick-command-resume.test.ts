import { describe, expect, it } from 'vitest'
import {
  isAgentLikeQuickCommandText,
  isPersistableQuickCommandRef,
  isQuickCommandStampOnlyLaunchConfig,
  isWrapperTextSafeToAppendResume,
  resolveQuickCommandResumeText,
  stripStaleResumeSelectors
} from './quick-command-resume'
import type { TerminalQuickCommand } from './terminal-quick-command-types'

const COMMANDS: TerminalQuickCommand[] = [
  {
    id: 'quick-command-muse',
    label: 'muse',
    action: 'terminal-command',
    command: 'ccr muse --dangerously-skip-permissions --resume',
    appendEnter: true,
    scope: { type: 'global' }
  },
  {
    id: 'quick-command-mimo',
    label: 'mimo',
    action: 'terminal-command',
    command: 'ccr cline-mimo --dangerously-skip-permissions --resume',
    appendEnter: true,
    scope: { type: 'global' }
  },
  {
    id: 'quick-command-dupe',
    label: 'muse',
    action: 'terminal-command',
    command: 'ccr other --resume',
    appendEnter: true,
    scope: { type: 'global' }
  },
  {
    id: 'quick-command-prompt',
    label: 'ask',
    action: 'agent-prompt',
    agent: 'claude',
    prompt: 'hello',
    scope: { type: 'global' }
  },
  {
    id: 'quick-command-repo',
    label: 'scoped',
    action: 'terminal-command',
    command: 'ccr muse --resume',
    appendEnter: true,
    scope: { type: 'repo', repoId: 'repo-a' }
  },
  {
    id: 'quick-command-repo-other',
    label: 'scoped',
    action: 'terminal-command',
    command: 'ccr other --resume',
    appendEnter: true,
    scope: { type: 'repo', repoId: 'repo-b' }
  }
]

describe('resolveQuickCommandResumeText', () => {
  it('resolves the current command text by id', () => {
    expect(
      resolveQuickCommandResumeText(COMMANDS, {
        quickCommandId: 'quick-command-muse',
        quickCommandLabel: 'muse'
      })
    ).toBe('ccr muse --dangerously-skip-permissions --resume')
  })

  it('prefers the id when the label is ambiguous', () => {
    expect(
      resolveQuickCommandResumeText(COMMANDS, {
        quickCommandId: 'quick-command-dupe',
        quickCommandLabel: 'muse'
      })
    ).toBe('ccr other --resume')
  })

  it('returns null on an ambiguous label-only ref instead of guessing', () => {
    expect(resolveQuickCommandResumeText(COMMANDS, { quickCommandLabel: 'muse' })).toBeNull()
  })

  it('resolves a label-only ref by its unique label', () => {
    expect(resolveQuickCommandResumeText(COMMANDS, { quickCommandLabel: 'mimo' })).toBe(
      'ccr cline-mimo --dangerously-skip-permissions --resume'
    )
  })

  it('does not fall back to a same-label command when the stored id is gone', () => {
    expect(
      resolveQuickCommandResumeText(COMMANDS, {
        quickCommandId: 'quick-command-deleted',
        quickCommandLabel: 'mimo'
      })
    ).toBeNull()
  })

  it('scopes label resolution to the requesting repo', () => {
    expect(resolveQuickCommandResumeText(COMMANDS, { quickCommandLabel: 'scoped' }, 'repo-a')).toBe(
      'ccr muse --resume'
    )
    expect(resolveQuickCommandResumeText(COMMANDS, { quickCommandLabel: 'scoped' }, 'repo-b')).toBe(
      'ccr other --resume'
    )
    // Why: without a repo scope, two same-label commands are ambiguous.
    expect(resolveQuickCommandResumeText(COMMANDS, { quickCommandLabel: 'scoped' })).toBeNull()
  })

  it('returns null for agent-prompt commands, missing refs, and empty input', () => {
    expect(
      resolveQuickCommandResumeText(COMMANDS, {
        quickCommandId: 'quick-command-prompt',
        quickCommandLabel: 'ask'
      })
    ).toBeNull()
    expect(resolveQuickCommandResumeText(COMMANDS, { quickCommandLabel: 'deleted' })).toBeNull()
    expect(resolveQuickCommandResumeText(COMMANDS, null)).toBeNull()
    expect(resolveQuickCommandResumeText([], { quickCommandLabel: 'muse' })).toBeNull()
  })

  it('refuses a linked command later edited into a non-agent command', () => {
    const edited: TerminalQuickCommand[] = [
      {
        id: 'deploy',
        label: 'deploy',
        action: 'terminal-command',
        command: './deploy.sh prod',
        appendEnter: true,
        scope: { type: 'global' }
      }
    ]
    expect(resolveQuickCommandResumeText(edited, { quickCommandId: 'deploy' })).toBeNull()
  })

  it('rejects multiline compound commands instead of misattaching the selector', () => {
    const multiline: TerminalQuickCommand[] = [
      {
        id: 'multi',
        label: 'multi',
        action: 'terminal-command',
        command: 'ccr muse --resume\n--dangerously-skip-permissions',
        appendEnter: true,
        scope: { type: 'global' }
      }
    ]
    expect(resolveQuickCommandResumeText(multiline, { quickCommandId: 'multi' })).toBeNull()
  })
})

describe('stripStaleResumeSelectors', () => {
  it.each(['posix', 'powershell', 'cmd'] as const)(
    'strips a stale wrapper selector (%s)',
    (shell) => {
      expect(stripStaleResumeSelectors('ccr muse --resume old-session', shell)).toBe('ccr muse')
      expect(stripStaleResumeSelectors('ccr muse --resume=old-session', shell)).toBe('ccr muse')
      expect(stripStaleResumeSelectors('ccr muse --resume', shell)).toBe('ccr muse')
      expect(stripStaleResumeSelectors('ccr muse --continue', shell)).toBe('ccr muse')
    }
  )

  it('keeps surviving wrapper args when stripping selectors', () => {
    expect(
      stripStaleResumeSelectors('ccr muse --dangerously-skip-permissions --resume stale', 'posix')
    ).toBe('ccr muse --dangerously-skip-permissions')
  })

  it('strips only the given resume flag for non-claude agents', () => {
    expect(
      stripStaleResumeSelectors('wrap -c key=v -r x --resume old', 'posix', {
        resumeFlag: '--resume'
      })
    ).toBe('wrap -c key=v -r x')
    expect(
      stripStaleResumeSelectors('wrap --session=old -c k=v', 'posix', {
        resumeFlag: '--session'
      })
    ).toBe('wrap -c k=v')
  })

  it("keeps a preceding wrapper's own -c/-r and cuts only after the agent binary", () => {
    expect(
      stripStaleResumeSelectors('nix develop -c claude --resume old', 'posix', {
        agentBinary: 'claude'
      })
    ).toBe('nix develop -c claude')
    expect(
      stripStaleResumeSelectors('docker run -c 512 img claude -c', 'posix', {
        agentBinary: 'claude'
      })
    ).toBe('docker run -c 512 img claude')
  })

  it('cuts only long selectors when the text never names the agent', () => {
    expect(
      stripStaleResumeSelectors('ccr muse -c cfg --resume old', 'posix', { agentBinary: 'claude' })
    ).toBe('ccr muse -c cfg')
  })

  it('drops a subcommand resume together with its own options', () => {
    expect(
      stripStaleResumeSelectors('codex -c k=v resume --last', 'posix', {
        agentBinary: 'codex',
        resumeFlag: 'resume'
      })
    ).toBe('codex -c k=v')
  })

  it('leaves `resume` alone when it is an option value of a wrapper', () => {
    expect(
      stripStaleResumeSelectors('wrap --profile resume -x', 'posix', {
        agentBinary: 'codex',
        resumeFlag: 'resume'
      })
    ).toBe('wrap --profile resume -x')
  })

  it('does not swallow an operand after a joined-only resume flag', () => {
    expect(
      stripStaleResumeSelectors('copilot --resume "do thing"', 'posix', {
        agentBinary: 'copilot',
        resumeFlag: '--resume',
        resumeFlagJoined: true
      })
    ).toBe('copilot "do thing"')
  })

  it('also cuts --continue for agents that resume by flag', () => {
    expect(
      stripStaleResumeSelectors('dsh-tui --continue web', 'posix', {
        agentBinary: 'dsh-tui',
        resumeFlag: '--resume'
      })
    ).toBe('dsh-tui web')
  })

  it('leaves non-selector text untouched', () => {
    expect(stripStaleResumeSelectors('ccr muse --model sonnet', 'posix')).toBe(
      'ccr muse --model sonnet'
    )
  })

  it.each([
    'ccr muse --resume && echo hi',
    'ccr muse --resume | tee log.txt',
    'ccr muse --resume ; echo hi',
    'ccr muse --resume $(cat sid)',
    'ccr muse --resume # note'
  ])('fails open byte-for-byte on shell syntax: %s', (command) => {
    // Why: without the diverging-span bail the operand absorption eats `&&`
    // or `|` as if it were the stale session id, silently deleting the
    // operator (`ccr muse --resume $(cat sid)` collapsed to `ccr muse sid)`).
    expect(stripStaleResumeSelectors(command, 'posix')).toBe(command)
  })
})

describe('isWrapperTextSafeToAppendResume', () => {
  it('accepts plain wrapper text and lets the resume selector be appended', () => {
    expect(
      isWrapperTextSafeToAppendResume('ccr muse --dangerously-skip-permissions', 'posix')
    ).toBe(true)
    expect(isWrapperTextSafeToAppendResume('ccr muse --resume stale-id', 'posix')).toBe(true)
  })

  it.each([
    ['ccr muse --resume && echo hi', 'posix'],
    ['ccr muse --resume | tee log.txt', 'posix'],
    ['ccr muse --resume $(cat sid)', 'posix'],
    ['ccr muse --resume # note', 'posix']
  ] as const)('rejects shell syntax so the append cannot misfire: %s (%s)', (command, shell) => {
    // Why: the appended `--resume <sid>` lands after `&&`/`|`, i.e. on the
    // LAST command, not the agent — the caller must fall back to stock.
    expect(isWrapperTextSafeToAppendResume(command, shell)).toBe(false)
  })

  it('rejects unmodelable text (unterminated quote)', () => {
    expect(isWrapperTextSafeToAppendResume("ccr muse --flag 'unterminated", 'posix')).toBe(false)
  })
})

describe('isAgentLikeQuickCommandText', () => {
  it('accepts agent binaries and wrapper commands carrying a selector', () => {
    expect(isAgentLikeQuickCommandText('claude --resume')).toBe(true)
    expect(isAgentLikeQuickCommandText('ccr muse --dangerously-skip-permissions --resume')).toBe(
      true
    )
  })

  it('rejects plain shell commands and bare wrappers', () => {
    expect(isAgentLikeQuickCommandText('git status')).toBe(false)
    expect(isAgentLikeQuickCommandText('pnpm dev')).toBe(false)
    expect(isAgentLikeQuickCommandText('ccr muse')).toBe(false)
    expect(isAgentLikeQuickCommandText('')).toBe(false)
  })

  it('rejects everyday short -r/-c flags on non-agent commands', () => {
    expect(isAgentLikeQuickCommandText('grep -r TODO .')).toBe(false)
    expect(isAgentLikeQuickCommandText('cp -r a b')).toBe(false)
    expect(isAgentLikeQuickCommandText('git -c color.ui=always log')).toBe(false)
  })

  it('looks past leading environment assignments', () => {
    expect(isAgentLikeQuickCommandText('CLAUDE_CONFIG_DIR=~/.claude-work claude')).toBe(true)
    expect(
      isAgentLikeQuickCommandText('ANTHROPIC_BASE_URL=http://localhost:8080 claude --model x')
    ).toBe(true)
    expect(isAgentLikeQuickCommandText('NODE_ENV=production node server.js')).toBe(false)
  })

  it('requires the agent binary when the shell cannot report command exit', () => {
    expect(isAgentLikeQuickCommandText('ccr muse --resume', { requireAgentBinary: true })).toBe(
      false
    )
    expect(isAgentLikeQuickCommandText('claude --model x', { requireAgentBinary: true })).toBe(true)
  })

  it('treats --resume, not --continue, as the wrapper opt-in', () => {
    expect(isAgentLikeQuickCommandText('aws-vault exec prod -- claude --resume')).toBe(true)
    expect(isAgentLikeQuickCommandText('claude-work --resume')).toBe(true)
    expect(isAgentLikeQuickCommandText('git rebase --continue')).toBe(false)
    expect(isAgentLikeQuickCommandText('git merge --continue')).toBe(false)
  })
})

describe('isQuickCommandStampOnlyLaunchConfig', () => {
  it('detects a ref-only stamp', () => {
    expect(
      isQuickCommandStampOnlyLaunchConfig({ agentArgs: '', agentEnv: {}, quickCommandId: 'q' })
    ).toBe(true)
  })

  it('treats configs with a recorded agentCommand or no ref as real launch inputs', () => {
    expect(
      isQuickCommandStampOnlyLaunchConfig({
        agentCommand: 'claude --x',
        agentArgs: '--x',
        agentEnv: {},
        quickCommandId: 'q'
      })
    ).toBe(false)
    expect(isQuickCommandStampOnlyLaunchConfig({ agentArgs: '', agentEnv: {} })).toBe(false)
    expect(isQuickCommandStampOnlyLaunchConfig(undefined)).toBe(false)
  })
})

describe('isPersistableQuickCommandRef', () => {
  it('accepts ordinary ids and labels', () => {
    expect(isPersistableQuickCommandRef('quick-command-muse')).toBe(true)
    expect(isPersistableQuickCommandRef('muse')).toBe(true)
  })

  it('rejects control chars, blanks, and overlong values', () => {
    expect(isPersistableQuickCommandRef('muse\ntab')).toBe(false)
    expect(isPersistableQuickCommandRef('muse\ttab')).toBe(false)
    expect(isPersistableQuickCommandRef('   ')).toBe(false)
    expect(isPersistableQuickCommandRef('x'.repeat(81))).toBe(false)
    expect(isPersistableQuickCommandRef(undefined)).toBe(false)
  })
})

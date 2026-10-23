import { existsSync } from 'node:fs'
import * as pty from 'node-pty'
import { describe, expect, it } from 'vitest'
import {
  buildTerminalQuickCommandInput,
  normalizeTerminalQuickCommandText,
  normalizeTerminalQuickCommands,
  isTerminalAgentQuickCommand
} from './terminal-quick-commands'
import { stageStartupCommand, discardStagedStartupCommand } from './startup-command-staging'
import { buildStartupCommandSubmission } from './startup-command-submission'

const script = `printf '%s\\n' \\
  'CONTINUATION_OK'
if [ 2 -gt 1 ]; then
  printf '%s\\n' 'BLOCK_OK'
fi
cat <<'END_BODY'
HEREDOC_OK
END_BODY
printf 'EXECUTION_%s\\n' END
cat <<'FINAL_BODY'
HEREDOC_FINAL_OK
FINAL_BODY

`
const shells =
  process.platform === 'win32'
    ? []
    : [
        {
          path: '/bin/bash',
          args: ['--noprofile', '--norc', '-i'],
          bracketedPaste: process.platform !== 'darwin'
        },
        {
          path: '/opt/homebrew/bin/bash',
          args: ['--noprofile', '--norc', '-i'],
          bracketedPaste: true
        },
        { path: '/bin/zsh', args: ['-f', '-i'], bracketedPaste: true }
      ].filter((shell) => existsSync(shell.path))

async function exercise(
  shell: (typeof shells)[number],
  mode: 'startup' | 'insert' | 'run',
  command = script,
  readsInput = false
) {
  const savedCommand = normalizeTerminalQuickCommands([
    { id: 'script', label: 'Script', command, appendEnter: mode === 'run' }
  ])[0]
  if (!savedCommand || isTerminalAgentQuickCommand(savedCommand)) {
    throw new Error('Expected a saved terminal script')
  }
  const proc = pty.spawn(shell.path, shell.args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    env: { ...process.env, PS1: 'QUICK_READY> ', PROMPT: 'QUICK_READY> ' }
  })
  let output = ''
  const listener = proc.onData((data) => {
    output += data
  })
  const waitFor = async (value: string) => {
    const deadline = Date.now() + 5000
    while (!output.includes(value) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(output).toContain(value)
  }
  let staged
  try {
    await waitFor('QUICK_READY> ')
    if (mode === 'startup') {
      staged = stageStartupCommand({
        command: normalizeTerminalQuickCommandText(savedCommand.command.replace(/\n/g, '\r\n')),
        shellPath: shell.path
      })
      expect(staged.delivery).toBe('staged')
      proc.write(buildStartupCommandSubmission(staged.command, { bracketedPasteSafe: false }))
    } else {
      await waitFor('\x1b[?2004h')
      proc.write(buildTerminalQuickCommandInput(savedCommand, { bracketedPasteSafe: true }))
      if (mode === 'insert') {
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(output).not.toContain('EXECUTION_END')
        proc.write('\r')
      }
    }
    if (readsInput) {
      await waitFor('INPUT_READY\r\n')
      proc.write('reader-value\r')
    }
    await waitFor('EXECUTION_END')
    if (readsInput) {
      expect(output).toContain('ANSWER_reader-value\r\n')
      expect(output).toContain('COMMAND_MUST_RUN\r\n')
    } else {
      expect(output).toContain('CONTINUATION_OK\r\n')
      expect(output).toContain('BLOCK_OK\r\n')
      expect(output).toContain('HEREDOC_OK\r\n')
      await waitFor('HEREDOC_FINAL_OK\r\n')
    }
  } finally {
    listener.dispose()
    proc.kill()
    discardStagedStartupCommand(staged)
  }
}

describe.each(shells)('saved shell scripts in $path', (shell) => {
  it('executes continuations, blocks and heredocs through new-tab staging', async () => {
    await exercise(shell, 'startup')
  })
})

describe.each(shells.filter((shell) => shell.bracketedPaste))(
  'saved script submission in $path',
  (shell) => {
    it('runs continuations, blocks and heredocs as one bracketed input', async () => {
      await exercise(shell, 'run')
    })

    it('inserts the whole script without executing until Enter', async () => {
      await exercise(shell, 'insert')
    })

    it.each(['startup', 'run'] as const)(
      '%s keeps later script lines out of a foreground command reading stdin',
      async (mode) => {
        await exercise(
          shell,
          mode,
          `printf 'INPUT_%s\\n' READY
read -r answer
printf 'ANSWER_%s\\n' "$answer"
printf 'COMMAND_%s\\n' MUST_RUN
printf 'EXECUTION_%s\\n' END`,
          true
        )
      }
    )
  }
)

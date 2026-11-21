/** STA-14925: Claude's argv read with the CLI's own grammar (2.1.322), failing safe when unsure. */

import { describe, expect, it } from 'vitest'
import { tokenizeCommandLine } from '../process/agent-command-line-entrypoint'
import { classifyClaudeArgv, type ClaudeArgvKind } from './claude-cli-argv-classification'

// Each row: the command as a shell title carries it, and what the installed CLI does with it.
const CASES: readonly (readonly [string, ClaudeArgvKind])[] = [
  // Sessions: bare, prompts, and options whose values only resemble a subcommand.
  ['claude', 'interactive-session'],
  ['claude fix the mcp server', 'interactive-session'],
  ['claude "mcp serve"', 'interactive-session'],
  ['claude help', 'interactive-session'],
  ['claude --resume', 'interactive-session'],
  ['claude --continue', 'interactive-session'],
  ['claude --model opus', 'interactive-session'],
  ['claude --model=opus "fix it"', 'interactive-session'],
  ['claude --name doctor', 'interactive-session'],
  ['claude -n doctor', 'interactive-session'],
  ['claude --name=doctor', 'interactive-session'],
  ['claude -ndoctor', 'interactive-session'],
  // An optional value takes the next token: `mcp` is the debug filter and `serve` the prompt.
  ['claude --debug mcp serve', 'interactive-session'],
  ['claude -d mcp serve', 'interactive-session'],
  ['claude -cd mcp serve', 'interactive-session'],
  ['claude --resume mcp serve', 'interactive-session'],
  ['claude -w doctor', 'interactive-session'],
  ['claude --debug', 'interactive-session'],
  ['claude --debug=hooks', 'interactive-session'],
  ['claude -c --verbose', 'interactive-session'],
  ['claude -cr', 'interactive-session'],
  // A variadic value takes every token up to the next option.
  ['claude --add-dir ../a ../b mcp serve', 'interactive-session'],
  ['claude --mcp-config servers.json doctor', 'interactive-session'],
  ['claude --plugin-dir a update', 'non-session-subcommand'],
  // After `--` or a first operand, later words are prompt text.
  ['claude -- --help', 'interactive-session'],
  ['claude -- fix mcp', 'interactive-session'],
  ['claude fix -- mcp list', 'interactive-session'],
  ['claude --permission-mode plan', 'interactive-session'],
  ['claude --prompt-suggestions', 'interactive-session'],
  ['claude --prompt-suggestions true mcp serve', 'non-session-subcommand'],
  // Subcommands that open a view or session in this terminal.
  ['claude agents', 'interactive-session'],
  ['claude agents --model opus --cwd ~/repo', 'interactive-session'],
  ['claude attach 1a2b', 'interactive-session'],
  ['claude --model opus attach 1a2b', 'interactive-session'],
  ['claude import', 'interactive-session'],
  ['claude import codex', 'interactive-session'],

  // Subcommands that never draw a composer, wherever the command position falls.
  ['claude mcp serve', 'non-session-subcommand'],
  ['claude mcp list', 'non-session-subcommand'],
  ['claude doctor', 'non-session-subcommand'],
  ['claude update', 'non-session-subcommand'],
  ['claude upgrade', 'non-session-subcommand'],
  ['claude install stable', 'non-session-subcommand'],
  ['claude setup-token', 'non-session-subcommand'],
  ['claude plugin install foo', 'non-session-subcommand'],
  ['claude --model opus mcp serve', 'non-session-subcommand'],
  ['claude --model=opus mcp serve', 'non-session-subcommand'],
  ['claude -- mcp list', 'non-session-subcommand'],
  ['claude --verbose -- mcp list', 'non-session-subcommand'],
  ['claude --debug=x mcp serve', 'non-session-subcommand'],
  ['claude -dx mcp serve', 'non-session-subcommand'],
  ['claude --debug --verbose mcp serve', 'non-session-subcommand'],
  ['claude -c mcp serve', 'non-session-subcommand'],
  ['claude --add-dir=../a mcp serve', 'non-session-subcommand'],
  ['claude --add-dir ../a --verbose mcp serve', 'non-session-subcommand'],
  ['claude --resume=x doctor', 'non-session-subcommand'],
  ['claude mcp serve --unknown-to-root', 'non-session-subcommand'],

  // Launches that return the terminal or never own it.
  ['claude --bg', 'non-foreground'],
  ['claude --background "fix the build"', 'non-foreground'],
  ['claude --bg --resume 1a2b', 'non-foreground'],
  ['claude --desktop', 'non-foreground'],
  ['claude --cloud', 'non-foreground'],
  ['claude --bg attach 1a2b', 'non-foreground'],
  ['claude -p "summarize the diff"', 'headless'],
  ['claude --print', 'headless'],
  ['claude "summarize" -p', 'headless'],
  ['claude -cp', 'headless'],
  ['claude --output-format json', 'headless'],
  ['claude --output-format=stream-json', 'headless'],
  ['claude agents --json', 'headless'],
  ['claude --help', 'informational'],
  ['claude -h', 'informational'],
  ['claude --version', 'informational'],
  ['claude -v', 'informational'],
  ['claude --model opus --help', 'informational'],
  ['claude attach --help', 'informational'],

  // Not positively recognized: never interactive.
  ['claude --bogus-flag', 'unclassified'],
  ['claude --bogus-flag mcp serve', 'unclassified'],
  ['claude -x', 'unclassified'],
  ['claude -cx', 'unclassified'],
  ['claude --verbose=1', 'unclassified'],
  ['claude --name', 'unclassified'],
  ['claude --name --help', 'unclassified'],
  ['claude --model -- mcp serve', 'unclassified'],
  ['claude --permission-mode bogus', 'unclassified'],
  ['claude --prompt-suggestions mcp serve', 'unclassified'],
  ['claude attach', 'unclassified'],
  ['claude attach a b', 'unclassified'],
  ['claude agents extra', 'unclassified'],
  ['claude import --dry-run', 'unclassified'],
  ['claude import --yes', 'unclassified'],
  ['claude import --bogus', 'unclassified']
]

describe('classifyClaudeArgv', () => {
  it.each(CASES)('%j is %s', (commandLine, kind) => {
    expect(classifyClaudeArgv(tokenizeCommandLine(commandLine).slice(1))).toBe(kind)
  })
})

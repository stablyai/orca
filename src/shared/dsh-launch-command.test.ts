import { describe, expect, it } from 'vitest'
import { isDshNonInteractiveCommand } from './dsh-launch-command'
import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'

function tokens(commandLine: string): string[] {
  return commandLine.split(' ')
}

describe('isDshNonInteractiveCommand', () => {
  it.each([
    'dsh web',
    'dsh --profile web',
    'dsh --profile=web --port 8080',
    'dsh --profile headless "run the tests"',
    'dsh --profile sdk',
    'dsh --profile sdk-minimal',
    'dsh --profile acp',
    'dsh plugin --profile dsh-tui add some-plugin',
    'dsh --profile dsh-tui --dump-config'
  ])('rejects %s', (commandLine) => {
    expect(isDshNonInteractiveCommand(tokens(commandLine))).toBe(true)
  })

  it.each([
    'dsh --profile dsh-tui',
    'dsh --profile=dsh-tui',
    'dsh --profile dsh-tui --resume 9478e2d8-29bc-4009-ab32-657efa2bd763',
    'dsh-tui',
    'dsh-tui --resume',
    'dst'
  ])('accepts %s', (commandLine) => {
    expect(isDshNonInteractiveCommand(tokens(commandLine))).toBe(false)
  })

  it('reads only the first --profile, so app arguments cannot retarget it', () => {
    // `--resume web` belongs to the terminal app, not the launcher.
    expect(isDshNonInteractiveCommand(tokens('dsh --profile dsh-tui --resume web'))).toBe(false)
  })

  it.each([
    'dsh-tui web',
    'dst web',
    'dsh-tui plugin',
    'dsh-tui --continue web',
    'dsh-tui /home/dev/projects/web',
    'node /usr/local/lib/node_modules/.bin/dsh-tui web',
    'C:\\Users\\dev\\AppData\\npm\\dsh-tui.cmd web'
  ])('keeps %s interactive: the launcher already chose the TUI profile', (commandLine) => {
    // Everything after `dsh-tui`/`dst` is the terminal app's argv — a workspace target or a
    // resume id — so a folder named `web` or `plugin` is a directory name, not a subcommand.
    expect(isDshNonInteractiveCommand(tokens(commandLine))).toBe(false)
  })
})

describe('dsh foreground process recognition', () => {
  it.each([
    'dsh-tui',
    'dst',
    '/opt/homebrew/bin/dsh --profile dsh-tui',
    'node /usr/local/lib/node_modules/.bin/dsh-tui',
    'node /home/dev/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/bin/dsh-tui.js',
    'node /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js --profile dsh-tui'
  ])('recognizes %s as dsh', (commandLine) => {
    expect(recognizeAgentProcessFromCommandLine(commandLine)?.agent).toBe('dsh')
  })

  it.each([
    'dsh web',
    'dsh --profile headless "summarize the diff"',
    'node /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js --profile acp'
  ])('does not claim %s as an interactive agent pane', (commandLine) => {
    expect(recognizeAgentProcessFromCommandLine(commandLine)).toBeNull()
  })

  it.each(['dsh-tui web', 'dst plugin'])(
    'still recognizes %s as the dsh agent pane',
    (commandLine) => {
      expect(recognizeAgentProcessFromCommandLine(commandLine)?.agent).toBe('dsh')
    }
  )

  it('still reports non-interactive dsh when headless one-shots are included', () => {
    // Non-interactivity guards ask for the wider set: a `dsh web` pane is not a shell
    // either, so callers that protect agent panes from reuse must still see it.
    expect(
      recognizeAgentProcessFromCommandLine('dsh --profile headless "go"', {
        includeHeadlessOneShot: true
      })?.agent
    ).toBe('dsh')
  })
})

import { describe, expect, it } from 'vitest'
import {
  hasControlByte,
  planStartupWithPromptCandidate,
  TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES,
  ZSH_MULTI_LINE_STARTUP_LINE_BUDGET_BYTES
} from './startup-line-prompt-carry'
import type { TuiAgent } from './tui-agent'
import { RUNTIME_CAPABILITIES } from './protocol-version'
import { AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY } from './agent-launch-runtime-capability'

function offer(
  agent: TuiAgent,
  prompt: string,
  extra: {
    cmdOverride?: string
    shellName?: string | undefined
    platform?: NodeJS.Platform
    provesAgentInFront?: boolean
  } = {}
) {
  return planStartupWithPromptCandidate(
    {
      agent,
      cmdOverrides: extra.cmdOverride ? { [agent]: extra.cmdOverride } : {},
      platform: extra.platform ?? 'darwin'
    },
    prompt,
    {
      ...(extra.shellName ? { shellName: extra.shellName } : {}),
      provesAgentInFront: extra.provesAgentInFront ?? true
    }
  )
}

/** `count` prompt lines of `bytes` each, as a multi-line source-control prompt is. */
function linesOf(count: number, bytes: number): string {
  return Array.from({ length: count }, (_unused, index) => `${index}:`.padEnd(bytes, 'x')).join(
    '\n'
  )
}

/** A prompt that brings the quoted `claude '<prompt>'` line to exactly `bytes`. */
function promptForClaudeLineOf(bytes: number): string {
  const base = offer('claude', '').plan?.launchCommand ?? ''
  // `<base> '<prompt>'`: one space and two quotes around the text.
  return 'x'.repeat(bytes - base.length - 3)
}

describe('whether a launch prompt rides the typed startup line', () => {
  it('carries a short single-line prompt on the launch command', () => {
    const { plan, promptCarried } = offer('claude', 'explain this repo')
    expect(promptCarried).toBe(true)
    expect(plan?.launchCommand).toContain('explain this repo')
  })

  it('carries a line of exactly the budget and refuses one byte past it', () => {
    const atBudget = offer('claude', promptForClaudeLineOf(TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES))
    expect(new TextEncoder().encode(atBudget.plan?.launchCommand ?? '').byteLength).toBe(
      TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES
    )
    expect(atBudget.promptCarried).toBe(true)

    const pastBudget = offer(
      'claude',
      promptForClaudeLineOf(TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES + 1)
    )
    expect(pastBudget.promptCarried).toBe(false)
  })

  it('measures the quoted line, so quote-heavy text under the budget raw can exceed it typed', () => {
    // 200 quotes are 200 raw bytes but 600 once portable quoting expands each to `"'"`.
    const quotes = "'".repeat(200)
    expect(quotes.length).toBeLessThan(TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES)
    const { plan, promptCarried } = offer('claude', quotes)
    expect(promptCarried).toBe(false)
    expect(plan?.launchCommand).not.toContain(`"'"`)
  })

  it.each([
    ['LF', 'first line\nsecond line'],
    ['CRLF', 'first line\r\nsecond line'],
    ['CR', 'first line\rsecond line']
  ])('never types a %s-bearing prompt, which a shell would read as Enter', (_label, prompt) => {
    const { plan, promptCarried } = offer('codex', prompt)
    expect(promptCarried).toBe(false)
    // The clean launch: the prompt is left for the paste after start.
    expect(plan?.launchCommand).not.toContain('first line')
    expect(plan?.followupPrompt).toBeNull()
  })

  it.each([
    ['TAB', 'see\tthis'],
    ['ESC', 'red \x1b[31mtext'],
    ['^C', 'stop\x03here'],
    ['^U', 'kill\x15line'],
    ['DEL', 'erase\x7fme']
  ])(
    'never types a %s-bearing prompt, which a line editor would read as a key',
    (_label, prompt) => {
      const { plan, promptCarried } = offer('claude', prompt)
      expect(promptCarried).toBe(false)
      expect(hasControlByte(plan?.launchCommand ?? '')).toBe(false)
    }
  )

  it('counts the launcher toward the line, so a long configured one leaves no room for the prompt', () => {
    const launcher = `claude ${'--add-dir /very/long/path '.repeat(30)}`.trim()
    expect(launcher.length).toBeGreaterThan(TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES)
    const { plan, promptCarried } = offer('claude', 'hi', { cmdOverride: launcher })
    expect(promptCarried).toBe(false)
    expect(plan?.launchCommand).toBe(launcher)
  })

  it('carries a Hermes prompt through its env transport, whose typed line never holds the text', () => {
    const multiLine = 'line one\nline two'
    const { plan, promptCarried } = offer('hermes', multiLine)
    expect(promptCarried).toBe(true)
    expect(plan?.launchCommand).not.toContain('line one')
    expect(Object.values(plan?.env ?? {})).toContain(multiLine)
  })

  it('launches Hermes clean instead of refusing when its env budget cannot hold the prompt', () => {
    const { plan, promptCarried } = offer('hermes', 'x'.repeat(30_000))
    expect(promptCarried).toBe(false)
    expect(plan).not.toBeNull()
    expect(Object.values(plan?.env ?? {}).join('')).not.toContain('xxxx')
  })

  it('never carries a stdin-after-start agent’s prompt, whose CLI takes none', () => {
    const { plan, promptCarried } = offer('aider', 'fix it')
    expect(promptCarried).toBe(false)
    expect(plan?.followupPrompt).toBeNull()
  })

  it('reports nothing carried for an empty prompt', () => {
    expect(offer('claude', '   ').promptCarried).toBe(false)
  })
})

// Pinned live by startup-line-typed-length.live-shell.test.ts; the refusals below were measured on
// macOS through the same write: a 1.1 KB single line lost to zsh's late write, every multi-line line
// lost to bash 3.2, and to fish whenever its config outlasted the ready barrier.
describe('a multi-line prompt typed into a shell the host names', () => {
  it('rides a zsh line as main typed it when each line is short, so the agent starts with it', () => {
    const prompt = linesOf(21, 100)
    const { plan, promptCarried } = offer('claude', prompt, { shellName: 'zsh' })
    expect(promptCarried).toBe(true)
    expect(plan?.launchCommand).toContain(prompt)
  })

  it('keeps a zsh line off the launch command when any one line exceeds the per-line budget', () => {
    const prompt = `${linesOf(3, 100)}\n${'y'.repeat(TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES + 1)}`
    expect(offer('claude', prompt, { shellName: 'zsh' }).promptCarried).toBe(false)
  })

  it('keeps a zsh line off the launch command past the whole-line budget', () => {
    const prompt = linesOf(Math.ceil(ZSH_MULTI_LINE_STARTUP_LINE_BUDGET_BYTES / 400) + 1, 400)
    expect(offer('claude', prompt, { shellName: 'zsh' }).promptCarried).toBe(false)
  })

  it('keeps a long single line off a zsh launch command, which a late write truncates', () => {
    const prompt = promptForClaudeLineOf(TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES + 1)
    expect(offer('claude', prompt, { shellName: 'zsh' }).promptCarried).toBe(false)
  })

  it.each([['bash'], ['fish'], ['pwsh'], [undefined]])(
    'never types a multi-line line into %s',
    (shellName) => {
      const { plan, promptCarried } = offer('claude', linesOf(3, 50), { shellName })
      expect(promptCarried).toBe(false)
      expect(plan?.launchCommand).not.toContain('0:')
    }
  )

  it.each([
    ['TAB', 'see\tthis\nnext line'],
    ['CR', 'first\r\nsecond']
  ])('never types a %s-bearing multi-line prompt into zsh', (_label, prompt) => {
    expect(offer('claude', prompt, { shellName: 'zsh' }).promptCarried).toBe(false)
  })
})

// Why: a host that cannot prove the agent took the terminal could paste into the shell of one that
// exited, so there the line carries the prompt whatever its size, as it did before.
describe('on a host that cannot prove the launched agent is in front', () => {
  it.each([
    ['a long single line', 'x'.repeat(TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES * 4)],
    ['a multi-line prompt', linesOf(5, 40)]
  ])('carries %s on the launch line', (_label, prompt) => {
    const { plan, promptCarried } = offer('claude', prompt, {
      platform: 'win32',
      provesAgentInFront: false
    })
    expect(promptCarried).toBe(true)
    expect(plan?.launchCommand).toContain(prompt.split('\n')[0])
    // Control: the same prompt is pasted where the host can prove the agent.
    expect(offer('claude', prompt, { platform: 'win32' }).promptCarried).toBe(false)
  })
})

describe('the capability clients gate a prompted launch on', () => {
  it('is advertised by every host that applies the typed-line rule', () => {
    // An older host folds any prompt into the typed line, so its absence is the gate.
    expect(RUNTIME_CAPABILITIES).toContain(AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY)
  })
})

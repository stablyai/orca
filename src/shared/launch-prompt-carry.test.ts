import { describe, expect, it } from 'vitest'
import { MAX_LINE_PROMPT_BYTES, carryInLaunchFile } from './launch-prompt-file'
import { planLaunchPrompt, type AgentLaunchPromptArgs } from './tui-agent-startup'
import type { TuiAgent } from './tui-agent'
import { RUNTIME_CAPABILITIES } from './protocol-version'
import { AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY } from './agent-launch-runtime-capability'
import { TYPED_STARTUP_LINE_BUDGET_BYTES, typedStartupLineFits } from './typed-startup-line'
import { describeLaunchHost } from './launch-host'
import {
  WINDOWS_CMD_LINE_MAX_CHARS,
  WINDOWS_POWERSHELL_LINE_MAX_CHARS
} from './windows-launch-line'

function plan(
  agent: TuiAgent,
  prompt: string,
  extra: Partial<Omit<AgentLaunchPromptArgs, 'agent' | 'prompt'>> = {}
) {
  const platform = extra.platform ?? 'darwin'
  // A local launch on that platform, with #24257's guarded paste, unless the test says otherwise.
  const host = describeLaunchHost({
    launchPlatform: platform,
    isRemote: false,
    hostPlatform: platform,
    paired: false
  })
  return planLaunchPrompt({
    agent,
    prompt,
    cmdOverrides: {},
    platform,
    host,
    paste: 'when-host-proves-agent',
    ...extra
  })
}

describe('where a launch prompt rides', () => {
  it('builds a plain launch for an empty prompt', () => {
    expect(plan('claude', '  ')).toMatchObject({ carry: 'none' })
  })

  it('carries a short prompt on the line', () => {
    const planned = plan('claude', 'explain this repo')
    expect(planned?.carry).toBe('on-line')
    expect(planned?.carry === 'on-line' && planned.plan.launchCommand).toContain(
      'explain this repo'
    )
  })

  it.each([
    ['a 600-byte', 'x'.repeat(600)],
    ['a multi-line', 'first line\nsecond line'],
    ['a key-bearing', 'see\tthis \x1b[31mred']
  ])('carries %s prompt on the line of a POSIX host, which stages it', (_label, prompt) => {
    const planned = plan('codex', prompt)
    expect(planned?.carry).toBe('on-line')
    expect(planned?.carry === 'on-line' && planned.plan.launchCommand).toContain(prompt)
  })

  it.each<TuiAgent>(['claude', 'codex'])(
    'points %s at a launch file past the argv ceiling, with the full text in the file',
    (agent) => {
      const prompt = `${'y'.repeat(MAX_LINE_PROMPT_BYTES)}z`
      const planned = plan(agent, prompt)
      if (planned?.carry !== 'launch-file') {
        throw new Error(`expected a launch file, got ${planned?.carry}`)
      }
      expect(planned.launchFile).toMatchObject({ content: prompt })
      expect(planned.plan.launchCommand).toContain(planned.launchFile.placeholder)
      expect(planned.plan.launchCommand).not.toContain('yyyy')
    }
  )

  // The bug class this outcome removes: a plan that exists but does not carry the prompt.
  it('leaves a file-sized prompt for the paste for an agent not measured reading the file', () => {
    const prompt = 'g'.repeat(MAX_LINE_PROMPT_BYTES + 1)
    const planned = plan('gemini', prompt)
    if (planned?.carry !== 'paste-after-ready') {
      throw new Error(`expected the paste, got ${planned?.carry}`)
    }
    expect(planned.text).toBe(prompt)
    expect(planned.cleanPlan.launchCommand).not.toContain('gggg')
  })

  // Why: main started such an agent with the whole prompt on its line; a caller with no paste
  // (agentSession.create, a phone quick command) must not refuse it now.
  it('keeps a file-sized prompt on the line for a caller that cannot paste', () => {
    const prompt = 'g'.repeat(MAX_LINE_PROMPT_BYTES + 1)
    const planned = plan('gemini', prompt, { paste: 'never' })
    expect(planned?.carry).toBe('on-line')
    expect(planned?.carry === 'on-line' && planned.plan.launchCommand).toContain('gggg')
  })

  it('leaves a stdin-after-start agent’s prompt for the paste', () => {
    const planned = plan('aider', 'fix it')
    expect(planned).toMatchObject({ carry: 'paste-after-ready', text: 'fix it' })
  })

  it('names a launch file its caller wrote, quoted for the line', () => {
    const { prompt, launchFile } = carryInLaunchFile('worker brief')
    const planned = plan('claude', prompt, { launchFile })
    expect(planned).toMatchObject({
      carry: 'launch-file',
      launchFile: { ...launchFile, quoting: 'posix' }
    })
  })
})

describe('a host that types the line raw', () => {
  // Why: the user's own words stay in the agent's history wherever a Windows line carries them;
  // the per-shell measurements are in windows-launch-line.test.ts.
  it('keeps an exact cmd line up to cmd’s cap and points Claude at a file past it', () => {
    const extra = { platform: 'win32' as const, shell: 'cmd' as const }
    expect(plan('claude', 'y'.repeat(4_000), extra)?.carry).toBe('on-line')
    expect(plan('claude', 'y'.repeat(WINDOWS_CMD_LINE_MAX_CHARS), extra)?.carry).toBe('launch-file')
  })

  it('keeps a PowerShell line to CreateProcess’s cap and points Claude at a file past it', () => {
    const extra = { platform: 'win32' as const, shell: 'powershell' as const }
    expect(plan('claude', 'y'.repeat(20_000), extra)?.carry).toBe('on-line')
    expect(plan('claude', 'y'.repeat(WINDOWS_POWERSHELL_LINE_MAX_CHARS), extra)?.carry).toBe(
      'launch-file'
    )
  })

  it('points Codex at a file for a Windows-damaged prompt, and keeps it on Gemini’s line', () => {
    const prompt = 'fix the build\nthen run the tests'
    expect(plan('codex', prompt, { platform: 'win32', shell: 'cmd' })?.carry).toBe('launch-file')
    // A Windows host cannot prove Gemini is in front to paste into, so it types it as main did.
    expect(plan('gemini', prompt, { platform: 'win32', shell: 'cmd' })?.carry).toBe('on-line')
  })

  // Why: main pastes an AI button's or notes send's prompt once the agent runs, and runs the action
  // on that paste; a Windows host cannot prove the agent in front to confirm a carried prompt, so
  // even a short exact line is pasted there (final review P1-1).
  it.each<TuiAgent>(['claude', 'codex'])(
    'pastes every prompt on a Windows host for a caller whose paste main used, for %s',
    (agent) => {
      const paste = 'once-agent-runs' as const
      const multiLine = 'fix the build\nthen run the tests'
      const pasted = plan(agent, multiLine, { platform: 'win32', shell: 'cmd', paste })
      expect(pasted).toMatchObject({ carry: 'paste-after-ready', text: multiLine })
      const long = 'y'.repeat(20_000)
      expect(plan(agent, long, { platform: 'win32', shell: 'cmd', paste })?.carry).toBe(
        'paste-after-ready'
      )
      expect(plan(agent, 'fix it', { platform: 'win32', shell: 'cmd', paste })?.carry).toBe(
        'paste-after-ready'
      )
      // A host that proves the agent keeps the exact line for the same caller.
      expect(plan(agent, 'fix it', { platform: 'darwin', paste })?.carry).toBe('on-line')
      const typed = plan(agent, multiLine, { platform: 'win32', shell: 'cmd' })
      expect(typed?.carry).toBe('launch-file')
    }
  )

  it('pastes a Windows-damaged prompt for any agent when the caller’s paste is main’s', () => {
    const extra = { platform: 'win32' as const, shell: 'powershell' as const }
    expect(plan('gemini', 'say "hi"', { ...extra, paste: 'once-agent-runs' })?.carry).toBe(
      'paste-after-ready'
    )
    expect(plan('gemini', 'say "hi"', extra)?.carry).toBe('on-line')
  })

  // Why: a 20 KB Fix-checks prompt on macOS arrives as the user's text, never a pointer.
  it('stages a long POSIX prompt on the line, and past the ceiling pastes where main pasted', () => {
    expect(plan('claude', 'y'.repeat(20_000), { paste: 'once-agent-runs' })?.carry).toBe('on-line')
    const huge = 'y'.repeat(MAX_LINE_PROMPT_BYTES + 1)
    expect(plan('claude', huge, { paste: 'once-agent-runs' })?.carry).toBe('paste-after-ready')
    expect(plan('claude', huge)?.carry).toBe('launch-file')
  })

  it('measures the argv ceiling in UTF-8 bytes, not characters', () => {
    // 99,999 bytes in 33,333 three-byte characters.
    const underCeiling = '日'.repeat(Math.floor(MAX_LINE_PROMPT_BYTES / 3))
    expect(plan('claude', underCeiling)?.carry).toBe('on-line')
    expect(plan('claude', '日'.repeat(MAX_LINE_PROMPT_BYTES / 3 + 1))?.carry).toBe('launch-file')
  })

  // Why: a host that cannot prove the agent holds its terminal refuses a paste (#24257), so the
  // line carries what the paste would have, as main typed it; Claude and Codex still get the file.
  it('keeps a prompt on the line of a host that cannot paste, unless a file can carry it', () => {
    // A local WSL pane: a Linux line, on a Windows host that cannot read what holds it.
    const extra = {
      platform: 'linux' as const,
      host: {
        paired: false,
        provesAgentInFront: false,
        takesLaunchFile: true,
        windowsPaneShell: null
      }
    }
    const prompt = 'fix the build\nthen run the tests'
    expect(plan('gemini', prompt, extra)?.carry).toBe('on-line')
    const huge = 'y'.repeat(MAX_LINE_PROMPT_BYTES + 1)
    expect(plan('gemini', huge, extra)?.carry).toBe('on-line')
    expect(plan('claude', huge, extra)?.carry).toBe('launch-file')
    expect(plan('aider', prompt, extra)?.carry).toBe('paste-after-ready')
    // An AI button's paste is main's, which ran in WSL too.
    const button = { ...extra, paste: 'once-agent-runs' as const }
    expect(plan('gemini', huge, button)?.carry).toBe('paste-after-ready')
  })

  // Why: its relay may run the pane in WSL, where no launch file is written; main typed the line or
  // pasted, so that is the fallback, never a refusal.
  it('gives an SSH Windows host no launch file: the line, or the paste main used', () => {
    const host = describeLaunchHost({
      launchPlatform: 'win32',
      isRemote: true,
      hostPlatform: 'darwin',
      paired: false
    })
    const prompt = 'fix the build\nthen run the tests'
    const extra = { platform: 'win32' as const, shell: 'cmd' as const, host }
    expect(plan('claude', prompt, extra)?.carry).toBe('on-line')
    expect(plan('codex', 'y'.repeat(MAX_LINE_PROMPT_BYTES + 1), extra)?.carry).toBe('on-line')
    expect(plan('claude', prompt, { ...extra, paste: 'once-agent-runs' })?.carry).toBe(
      'paste-after-ready'
    )
    expect(plan('claude', 'fix it', extra)?.carry).toBe('on-line')
  })

  // Why: a host that cannot write its staging folder types a long line raw, so the plan picks
  // main's delivery up front: the paste where main pasted, the line where main typed it.
  it('plans a host that cannot stage for main’s delivery, not a staged line or a file', () => {
    const extra = {
      platform: 'linux' as const,
      host: {
        paired: false,
        provesAgentInFront: true,
        takesLaunchFile: false,
        windowsPaneShell: null
      }
    }
    const long = 'y'.repeat(20_000)
    expect(plan('claude', 'fix it', extra)?.carry).toBe('on-line')
    expect(plan('claude', long, { ...extra, paste: 'once-agent-runs' })?.carry).toBe(
      'paste-after-ready'
    )
    expect(plan('claude', long, extra)?.carry).toBe('paste-after-ready')
    expect(plan('codex', 'first line\nsecond line', extra)?.carry).toBe('paste-after-ready')
    expect(plan('claude', long, { ...extra, paste: 'never' })?.carry).toBe('on-line')
  })

  it('pastes on a paired host what its line cannot carry typed, even for Claude', () => {
    const extra = {
      platform: 'linux' as const,
      host: {
        paired: true,
        provesAgentInFront: true,
        takesLaunchFile: false,
        windowsPaneShell: null
      }
    }
    expect(plan('claude', 'fix it', extra)?.carry).toBe('on-line')
    expect(plan('claude', 'first line\nsecond line', extra)?.carry).toBe('paste-after-ready')
    expect(plan('claude', 'z'.repeat(20_000), extra)?.carry).toBe('paste-after-ready')
  })
})

describe('whether a line can be typed as it is', () => {
  it('holds a line to half of macOS MAX_CANON', () => {
    expect(typedStartupLineFits('x'.repeat(TYPED_STARTUP_LINE_BUDGET_BYTES))).toBe(true)
    expect(typedStartupLineFits('x'.repeat(TYPED_STARTUP_LINE_BUDGET_BYTES + 1))).toBe(false)
  })

  it.each(['\n', '\r', '\t', '\x1b', '\x03', '\x7f'])('never types a line with %j', (byte) => {
    expect(typedStartupLineFits(`a${byte}b`)).toBe(false)
  })
})

describe('the capability clients gate a prompted launch on', () => {
  it('is advertised by every host that delivers a prompt its typed line cannot carry as typed', () => {
    // An older host types any prompt into the line, so its absence is the gate.
    expect(RUNTIME_CAPABILITIES).toContain(AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY)
  })
})

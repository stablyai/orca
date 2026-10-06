import { describe, expect, it } from 'vitest'
import { describeLaunchHost, type WindowsPowerShell } from './launch-host'
import { planLaunchPrompt } from './tui-agent-startup'
import { windowsLaunchLineVerdict } from './windows-launch-line'
import { quoteStartupArg, type AgentStartupShell } from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'

// The stack QA's prompts (Windows lane, 2026-10-02), built the way its rig built them.
function qaLine(tag: string, length: number): string {
  let text = `QA-STACK ${tag} start.`
  for (let i = 1; text.length < length - 14; i += 1) {
    text += ` w${i}`
  }
  text += ` ${tag} end.`
  return text.padEnd(length, '.').slice(0, length)
}

const PROMPTS = {
  p2k: qaLine('P2K', 2048),
  p20k: qaLine('P20K', 20480),
  p100k: qaLine('P100K', 99000),
  ml5: [1, 2, 3, 4, 5]
    .map((i) => `QA-STACK ML5 line ${i}: inert text, do not run any command.`)
    .join('\n'),
  ml9k: Array.from({ length: 18 }, (_, i) => qaLine(`ML9K-L${i + 1}`, 500)).join('\n'),
  e8100: qaLine('E8100', 8100),
  e8191: qaLine('E8191', 8191),
  pq: 'QA-STACK PQ one line with a "double quote" inside, inert, do not run any command.',
  ppct: 'QA-STACK PPCT one line with a %QAVAR% pair inside, inert, do not run any command.',
  pbs: 'QA-STACK PBS one line ending in a backslash, inert, do not run any command \\'
} as const

type Row = keyof typeof PROMPTS

function windowsHost(windowsPowerShell: WindowsPowerShell | null) {
  return describeLaunchHost({
    launchPlatform: 'win32',
    isRemote: false,
    hostPlatform: 'win32',
    paired: false,
    windowsPaneShell: windowsPowerShell
  })
}

function carry(
  agent: TuiAgent,
  row: Row,
  shell: AgentStartupShell,
  command = `node C:/Users/neil/orca-qa/stack-final/win/bin/stub.js --qa-as=${agent}`,
  windowsPowerShell: WindowsPowerShell | null = null
) {
  return planLaunchPrompt({
    agent,
    prompt: PROMPTS[row],
    cmdOverrides: { [agent]: command },
    platform: 'win32',
    shell,
    host: windowsHost(windowsPowerShell),
    paste: 'when-host-proves-agent'
  })?.carry
}

// Each row: what main's typed line did, then the carry it gets. A launch file only where main's
// line was measured to damage or lose the prompt; everywhere else the line, as main typed it.
describe('an agent.launch prompt on a Windows host, per measured shell', () => {
  it.each<[AgentStartupShell, Row, string, 'on-line' | 'launch-file']>([
    ['cmd', 'p2k', 'exact', 'on-line'],
    ['cmd', 'p20k', 'input line too long', 'launch-file'],
    ['cmd', 'ml5', 'damaged', 'launch-file'],
    ['cmd', 'ml9k', 'input line too long', 'launch-file'],
    ['cmd', 'e8100', 'exact', 'on-line'],
    ['cmd', 'e8191', 'input line too long', 'launch-file'],
    ['cmd', 'pq', 'damaged by main’s quoting, exact on this line', 'on-line'],
    ['cmd', 'ppct', 'damaged by main’s quoting, exact on this line', 'on-line'],
    ['cmd', 'pbs', 'damaged by main’s quoting, exact on this line', 'on-line'],
    ['powershell', 'p2k', 'exact on 5.1 and 7', 'on-line'],
    ['powershell', 'p20k', 'exact on 5.1 and 7', 'on-line'],
    ['powershell', 'p100k', 'never started on 5.1 and 7', 'launch-file'],
    ['powershell', 'ml5', 'exact on 5.1 and 7', 'on-line'],
    ['powershell', 'ml9k', 'damaged on 5.1, lines run as commands on 7', 'launch-file'],
    ['powershell', 'e8191', 'exact on 5.1 and 7', 'on-line'],
    ['powershell', 'pq', 'exact on 7, damaged on 5.1 (PowerShell unknown here)', 'on-line'],
    ['powershell', 'ppct', 'exact on 5.1 and 7', 'on-line'],
    ['powershell', 'pbs', 'exact on 7, damaged on 5.1 (PowerShell unknown here)', 'on-line'],
    ['posix', 'p2k', 'exact in Git Bash', 'on-line'],
    ['posix', 'p20k', 'never started in Git Bash', 'launch-file'],
    ['posix', 'ml5', 'exact in Git Bash', 'on-line'],
    ['posix', 'ml9k', 'exact in Git Bash', 'on-line'],
    ['posix', 'e8191', 'exact in Git Bash', 'on-line'],
    ['posix', 'pq', 'exact in Git Bash', 'on-line'],
    ['posix', 'ppct', 'exact in Git Bash', 'on-line'],
    ['posix', 'pbs', 'exact in Git Bash', 'on-line']
  ])('%s %s (main: %s) rides %s', (shell, row, _main, expected) => {
    expect(carry('claude', row, shell)).toBe(expected)
    expect(carry('codex', row, shell)).toBe(expected)
  })

  // Why: this Orca spawns the pane, so it knows which PowerShell gets the line. 5.1's measured
  // damage gets a launch file, better than main; 7 keeps the line it carried exactly.
  it.each<[Row, WindowsPowerShell, string, 'on-line' | 'launch-file']>([
    ['pq', 'powershell.exe', 'damaged on 5.1', 'launch-file'],
    ['pbs', 'powershell.exe', 'damaged on 5.1', 'launch-file'],
    ['ppct', 'powershell.exe', 'exact on 5.1', 'on-line'],
    ['ml5', 'powershell.exe', 'exact on 5.1', 'on-line'],
    ['p20k', 'powershell.exe', 'exact on 5.1', 'on-line'],
    ['pq', 'pwsh.exe', 'exact on 7', 'on-line'],
    ['pbs', 'pwsh.exe', 'exact on 7', 'on-line'],
    ['ppct', 'pwsh.exe', 'exact on 7', 'on-line'],
    ['ml9k', 'pwsh.exe', 'lines run as commands on 7', 'launch-file']
  ])('powershell %s spawned as %s (main: %s) rides %s', (row, ps, _main, expected) => {
    const command = (agent: TuiAgent) =>
      `node C:/Users/neil/orca-qa/stack-final/win/bin/stub.js --qa-as=${agent}`
    expect(carry('claude', row, 'powershell', command('claude'), ps)).toBe(expected)
    expect(carry('codex', row, 'powershell', command('codex'), ps)).toBe(expected)
  })

  // Why: a shim's cmd.exe re-reads the line, so cmd's cap, its `%NAME%` expansion and a cut at a
  // line break apply, and PowerShell hands a shim `"` and a trailing `\` the legacy way.
  it.each<[AgentStartupShell, Row, 'on-line' | 'launch-file']>([
    ['powershell', 'p2k', 'on-line'],
    ['powershell', 'pq', 'launch-file'],
    ['powershell', 'ppct', 'launch-file'],
    ['powershell', 'pbs', 'launch-file'],
    ['posix', 'ppct', 'launch-file'],
    ['posix', 'pq', 'on-line'],
    // Unmeasured through a shim (its cmd.exe's cap and line-break cut), so typed as main typed it.
    ['powershell', 'ml5', 'on-line'],
    ['powershell', 'e8191', 'on-line'],
    ['posix', 'ml5', 'on-line']
  ])('through a spelled-out .cmd shim, %s %s rides %s', (shell, row, expected) => {
    expect(carry('claude', row, shell, 'C:/Users/ada/AppData/Roaming/npm/claude.cmd')).toBe(
      expected
    )
  })

  // Why per shell (stack QA ptab/pcr): cmd and Git Bash read a Tab or carriage return as a key
  // (completion, or Enter, which in cmd runs the rest as commands); both PowerShells carried them.
  it.each<[AgentStartupShell, 'ptab' | 'pcr', 'on-line' | 'launch-file']>([
    ['cmd', 'ptab', 'launch-file'],
    ['cmd', 'pcr', 'launch-file'],
    ['posix', 'ptab', 'launch-file'],
    ['posix', 'pcr', 'launch-file'],
    ['powershell', 'ptab', 'on-line'],
    ['powershell', 'pcr', 'on-line']
  ])('types %s %s only where the shell carried it: %s', (shell, row, expected) => {
    const prompt =
      row === 'ptab'
        ? 'QA-STACK PTAB one line with a\ttab inside, inert, do not run any command.'
        : 'QA-STACK PCR one line with a bare\rCR inside, inert, do not run any command.'
    for (const windowsPowerShell of ['powershell.exe', 'pwsh.exe'] as const) {
      const planned = planLaunchPrompt({
        agent: 'claude',
        prompt,
        cmdOverrides: {},
        platform: 'win32',
        shell,
        host: windowsHost(windowsPowerShell),
        paste: 'when-host-proves-agent'
      })
      expect(planned?.carry).toBe(expected)
    }
  })

  // Why (Windows CI): no QA row carried a non-ASCII prompt into cmd, and the piped-stdin harness
  // garbles it, so cmd leaves one to main's delivery; PowerShell and Git Bash rows are unchanged.
  it('leaves a non-ASCII prompt on cmd to main’s delivery', () => {
    const planned = (shell: AgentStartupShell, paste: 'once-agent-runs' | 'never') =>
      planLaunchPrompt({
        agent: 'claude',
        prompt: '日本語 café',
        cmdOverrides: {},
        platform: 'win32',
        shell,
        host: windowsHost('pwsh.exe'),
        paste
      })?.carry
    expect(planned('cmd', 'never')).toBe('on-line')
    expect(planned('cmd', 'once-agent-runs')).toBe('paste-after-ready')
    expect(windowsLaunchLineVerdict('日本語 café', "claude '日本語 café'", 'cmd', null)).toBe(
      'uncertain'
    )
    expect(windowsLaunchLineVerdict('日本語 café', "claude '日本語 café'", 'posix', null)).toBe(
      'exact'
    )
  })

  it('leaves another control byte, never measured, to main’s delivery', () => {
    const planned = (paste: 'once-agent-runs' | 'when-host-proves-agent') =>
      planLaunchPrompt({
        agent: 'claude',
        prompt: 'before\x1bafter',
        cmdOverrides: {},
        platform: 'win32',
        shell: 'powershell',
        host: windowsHost('pwsh.exe'),
        paste
      })?.carry
    expect(planned('once-agent-runs')).toBe('paste-after-ready')
    expect(planned('when-host-proves-agent')).toBe('on-line')
  })

  // Why: an AI button's prompt was pasted on main, which ran the action on that paste. A Windows
  // host cannot prove the agent in front to confirm a carried prompt, so every row keeps the paste,
  // even one the shell carries exactly (final review P1-1).
  it.each<[AgentStartupShell, Row, 'on-line' | 'paste-after-ready']>([
    ['cmd', 'ml5', 'paste-after-ready'],
    ['cmd', 'pq', 'paste-after-ready'],
    ['powershell', 'ml5', 'paste-after-ready'],
    ['powershell', 'ml9k', 'paste-after-ready'],
    ['powershell', 'pq', 'paste-after-ready'],
    ['powershell', 'p20k', 'paste-after-ready'],
    ['posix', 'ml9k', 'paste-after-ready'],
    ['posix', 'p20k', 'paste-after-ready']
  ])('an AI button on %s with %s gets %s', (shell, row, expected) => {
    const planned = planLaunchPrompt({
      agent: 'claude',
      prompt: PROMPTS[row],
      cmdOverrides: {
        claude: 'node C:/Users/neil/orca-qa/stack-final/win/bin/stub.js --qa-as=claude'
      },
      platform: 'win32',
      shell,
      host: describeLaunchHost({
        launchPlatform: 'win32',
        isRemote: false,
        hostPlatform: 'win32',
        paired: false
      }),
      paste: 'once-agent-runs'
    })
    expect(planned?.carry).toBe(expected)
  })
})

// Why: PowerShell quotes a multi-line prompt onto one physical line (#23672), so its line breaks
// are in the prompt, not the line, and the measured multi-line rows must still apply.
describe('a multi-line prompt PowerShell quotes onto one line', () => {
  const line = (command: string, row: Row) =>
    `${command} ${quoteStartupArg(PROMPTS[row], 'powershell')}`

  const stub = 'node C:/Users/neil/orca-qa/stack-final/win/bin/stub.js --qa-as=claude'

  it.each<[Row, 'exact' | 'damaged']>([
    ['ml5', 'exact'],
    ['ml9k', 'damaged']
  ])('keeps %s at its measured verdict', (row, expected) => {
    expect(line(stub, row)).not.toMatch(/[\r\n]/)
    expect(windowsLaunchLineVerdict(PROMPTS[row], line(stub, row), 'powershell', null)).toBe(
      expected
    )
  })

  it('leaves it unmeasured through a .cmd shim, whose cmd.exe cuts at a line break', () => {
    const shimLine = line('C:/Users/ada/AppData/Roaming/npm/claude.cmd', 'ml5')
    expect(windowsLaunchLineVerdict(PROMPTS.ml5, shimLine, 'powershell', null)).toBe('uncertain')
  })
})

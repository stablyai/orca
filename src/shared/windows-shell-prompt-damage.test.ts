import { describe, expect, it } from 'vitest'
import { planLaunchForTest } from './launch-prompt-plan.test-fixture'
import { buildLaunchFilePointer, isLaunchFilePointer } from './launch-prompt-file'
import { buildAgentDraftLaunchPlan } from './tui-agent-startup'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import { windowsDraftRefusal } from './launch-prompt-carry'

const SHIM = 'C:/Users/ada/AppData/Roaming/npm/claude.cmd'

function plan(prompt: string, shell: AgentStartupShell, command?: string) {
  return planLaunchForTest({
    agent: 'claude',
    prompt,
    cmdOverrides: command ? { claude: command } : {},
    platform: shell === 'posix' ? 'darwin' : 'win32',
    shell
  })
}

describe('a prompt a Windows shell would damage on the launch line', () => {
  // Measured (ps-quoting-matrix.md): PowerShell 5.1, and 7.x through a .cmd shim, split a `"` out of
  // the plain literal and turn a trailing backslash into `"`; the legacy-passing escape would let a
  // .cmd shim's cmd.exe run `&` and `<>` from inside the user's quotes. A spelled-out shim gets a
  // launch file. A bare name may be a native executable, where 7 carried them exactly (stack QA),
  // so its line is typed as main typed it.
  it.each([
    ['P1', 'fix the "foo bar" bug'],
    ['P2', '"leading quote" then text'],
    ['P3', 'trailing "quote"'],
    ['P4', 'a \\"backslash-quote\\" b'],
    ['P5', 'back\\slash\\\\ "q" end\\'],
    ['P7', 'replace "<b>" with "a & b"'],
    ['a bare path', 'see C:\\dir\\']
  ])(
    'moves %s into a launch file through a PowerShell shim, and types it for a bare name',
    (_, prompt) => {
      const startup = plan(prompt, 'powershell', SHIM)
      expect(startup?.launchFile?.content).toBe(prompt)
      expect(startup?.launchCommand).not.toContain('"')
      expect(startup?.launchCommand).not.toContain('Legacy')
      expect(plan(prompt, 'powershell')?.launchFile).toBeUndefined()
    }
  )

  // Measured form F-A: a pointer to a spaced path passed in every PowerShell and target.
  it('types P6, the backtick pointer, and quote-free prompts as a plain literal', () => {
    const prompt = 'The full task is in the file `C:\\Users\\John Smith\\t.md`. Read it.'
    expect(plan(prompt, 'powershell')?.launchCommand).toBe(`claude '${prompt}'`)
    expect(plan("fix Bob's build", 'powershell')?.launchCommand).toBe("claude 'fix Bob''s build'")
  })

  // Measured (QA-WIN R0-R2): through a `.cmd` shim, `%PATH%` reached the agent as 1,795 characters;
  // to a native executable it arrived (stack QA).
  it('moves a %NAME% pair into a launch file through a shim and keeps a lone percent typed', () => {
    expect(plan('echo %PATH% for me', 'powershell', SHIM)?.launchFile?.content).toBe(
      'echo %PATH% for me'
    )
    expect(plan('echo %PATH% for me', 'powershell')?.launchFile).toBeUndefined()
    expect(plan('coverage is 80% now', 'powershell')?.launchCommand).toBe(
      "claude 'coverage is 80% now'"
    )
    expect(plan('echo %PATH% for me', 'cmd')?.launchFile).toBeUndefined()
  })

  it('keeps `"` on the line for cmd and POSIX, whose quoting carries it', () => {
    expect(plan('fix the "foo bar" bug', 'cmd')?.launchFile).toBeUndefined()
    expect(plan('fix the "foo bar" bug', 'posix')?.launchFile).toBeUndefined()
  })

  // Why (final review P3-2): one measured predicate judges a draft's line as it judges a prompt's.
  // A measured damage pastes the draft; an unmeasured line (PowerShell `"`, which the pane's
  // PowerShell decides) is typed as main typed it.
  it('pastes a Windows draft only where its line was measured to damage it', () => {
    const draft = (text: string, shell: AgentStartupShell) =>
      buildAgentDraftLaunchPlan({
        agent: 'claude',
        draft: text,
        cmdOverrides: {},
        platform: 'win32',
        shell
      })
    expect(draft('line one\nline two', 'cmd')).toBeNull()
    expect(draft('say\thi', 'cmd')).toBeNull()
    expect(draft('say "hi"', 'powershell')?.launchCommand).toBe(`claude --prefill 'say "hi"'`)
    expect(draft('line one\nline two', 'powershell')?.launchCommand).toContain('line two')
    expect(draft('say hi', 'powershell')?.launchCommand).toBe("claude --prefill 'say hi'")
  })

  it('points at the file with no double quote in the sentence', () => {
    const path = 'C:\\Users\\John Smith\\AppData\\Local\\Temp\\orca-launch-file-a1\\task-context.md'
    expect(buildLaunchFilePointer(path)).toBe(
      `The full task is in the file \`${path}\`. Read it and complete the task it describes.`
    )
  })

  it('keeps the prompt on a paired Windows host’s line, which writes no file and cannot paste', () => {
    const startup = planLaunchForTest({
      agent: 'claude',
      prompt: 'fix the build\nthen run the tests',
      cmdOverrides: {},
      platform: 'win32',
      shell: 'powershell',
      host: {
        paired: true,
        provesAgentInFront: false,
        takesLaunchFile: false,
        windowsPaneShell: null
      }
    })
    expect(startup?.launchFile).toBeUndefined()
    expect(startup?.launchCommand).toContain('fix the build')
    expect(startup?.pasteAfterReady).toBeNull()
  })

  it('tells its own pointer apart from a prompt that merely mentions one', () => {
    expect(isLaunchFilePointer(buildLaunchFilePointer('C:\\Temp\\a b\\task-context.md'))).toBe(true)
    expect(isLaunchFilePointer('The full task is in the file `x`. Read it and do it.')).toBe(false)
    expect(isLaunchFilePointer('fix the build')).toBe(false)
  })

  it('says in plain words why a Windows shell draft was not launched', () => {
    expect(windowsDraftRefusal('claude', 'win32')).toMatch(
      /Windows shell would break this draft on the agent's command line, so the agent was not started/
    )
    expect(windowsDraftRefusal('claude', 'darwin')).toBeNull()
  })
})

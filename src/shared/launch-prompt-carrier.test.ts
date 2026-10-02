import { describe, expect, it } from 'vitest'
import { planLaunchForTest } from './launch-prompt-plan.test-fixture'
import { MAX_LINE_PROMPT_BYTES } from './launch-prompt-file'

const base = { agent: 'claude' as const, cmdOverrides: {} }

describe('the one launch-prompt decision every launch path builds through', () => {
  // Why: the composer, phone quick commands and background sessions call the builder directly.
  it('points a single-line cmd prompt past cmd’s 8,191-character line at a launch file', () => {
    const prompt = 'y'.repeat(9_000)
    const plan = planLaunchForTest({ ...base, prompt, platform: 'win32', shell: 'cmd' })
    expect(plan?.launchFile?.content).toBe(prompt)
    expect(plan?.launchCommand.length).toBeLessThan(8_191)
  })

  it('points a prompt past the argv ceiling at a launch file on a POSIX host too', () => {
    const prompt = 'z'.repeat(MAX_LINE_PROMPT_BYTES + 1)
    expect(planLaunchForTest({ ...base, prompt, platform: 'linux' })?.launchFile?.content).toBe(
      prompt
    )
  })

  it('keeps a paired host to the typed budget, pasting what it may neither stage nor read', () => {
    const short = planLaunchForTest({
      ...base,
      prompt: 'fix it',
      platform: 'linux',
      host: {
        paired: true,
        provesAgentInFront: true,
        takesLaunchFile: false,
        windowsPaneShell: null
      }
    })
    expect(short?.carry).toBe('on-line')
    const long = planLaunchForTest({
      ...base,
      prompt: 'fix it\nthen run the tests',
      platform: 'linux',
      host: {
        paired: true,
        provesAgentInFront: true,
        takesLaunchFile: false,
        windowsPaneShell: null
      }
    })
    expect(long?.carry).toBe('paste-after-ready')
    expect(long?.pasteAfterReady).toBe('fix it\nthen run the tests')
    expect(long?.launchCommand).not.toContain('run the tests')
  })

  // Why: the host writes a WSL session's staged line and launch file into the distro.
  it('plans a WSL launch like any Linux launch: long lines stay typed, huge ones get a file', () => {
    const typed = planLaunchForTest({ ...base, platform: 'linux', prompt: 'one\ntwo' })
    expect(typed?.launchCommand).toContain('two')
    expect(typed?.pasteAfterReady).toBeNull()
    const huge = 'c'.repeat(MAX_LINE_PROMPT_BYTES + 1)
    const pointed = planLaunchForTest({ ...base, platform: 'linux', prompt: huge })
    expect(pointed?.launchFile?.content).toBe(huge)
    expect(pointed?.pasteAfterReady).toBeNull()
  })
})

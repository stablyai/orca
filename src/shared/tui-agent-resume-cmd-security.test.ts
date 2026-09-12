import { describe, expect, it } from 'vitest'

import { buildAgentResumeStartupPlan } from './tui-agent-startup'

describe('cmd agent resume security', () => {
  it('accepts ordinary values and rejects unsafe opaque ids', () => {
    expect(
      buildAgentResumeStartupPlan({
        agent: 'grok',
        providerSession: { key: 'session_id', id: 'session with spaces' },
        cmdOverrides: {},
        platform: 'win32',
        shell: 'cmd'
      })?.launchCommand
    ).toBe('grok "--resume" "session with spaces"')

    for (const id of [
      'session & whoami',
      'session ^ caret',
      'session" --help "tail',
      'session%PATH%',
      'session!value!',
      'session\\',
      'session\nwhoami',
      'session\rwhoami'
    ]) {
      expect(
        buildAgentResumeStartupPlan({
          agent: 'grok',
          providerSession: { key: 'session_id', id },
          cmdOverrides: {},
          platform: 'win32',
          shell: 'cmd'
        })
      ).toBeNull()
    }
  })

  it('moves legal path characters out of the cmd command line', () => {
    const transcriptPath = "C:\\Program Files (x86)\\100% real!\\O'Malley & Sons\\session.jsonl"
    const startup = buildAgentResumeStartupPlan({
      agent: 'pi',
      providerSession: {
        key: 'session_id',
        id: 'session-1',
        transcriptPath
      },
      cmdOverrides: { pi: 'omo' },
      platform: 'win32',
      shell: 'cmd'
    })

    expect(startup?.launchCommand).toBe('orca agent resume-env')
    expect(startup?.env).toEqual(
      expect.objectContaining({
        ORCA_AGENT_RESUME_COMMAND: 'omo',
        ORCA_AGENT_RESUME_ARGV: JSON.stringify(['--session', transcriptPath])
      })
    )
  })

  it('preserves custom cmd syntax for the dedicated cmd launcher', () => {
    for (const baseCommand of [
      'set WRAPPER=1 & omo',
      '%LOCALAPPDATA%\\Programs\\omo.cmd',
      '!OMO_HOME!\\omo.cmd',
      '(omo)'
    ]) {
      const startup = buildAgentResumeStartupPlan({
        agent: 'pi',
        providerSession: {
          key: 'session_id',
          id: 'session-1',
          transcriptPath: 'C:\\Users\\100% real\\session.jsonl'
        },
        cmdOverrides: { pi: baseCommand },
        platform: 'win32',
        shell: 'cmd'
      })
      expect(startup?.launchCommand).toBe('orca agent resume-env')
      expect(startup?.env?.ORCA_AGENT_RESUME_COMMAND).toBe(baseCommand)
    }
  })

  it('rejects control characters before selecting the dedicated launcher', () => {
    const startup = buildAgentResumeStartupPlan({
      agent: 'pi',
      providerSession: {
        key: 'session_id',
        id: 'session-1',
        transcriptPath: 'C:\\Users\\safe\\session.jsonl\nwhoami'
      },
      cmdOverrides: { pi: 'omo' },
      platform: 'win32',
      shell: 'cmd'
    })
    expect(startup).toBeNull()
  })
})

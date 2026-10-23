import { describe, expect, it } from 'vitest'
import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from './tui-agent-startup'
import { isExpectedAgentProcess, recognizeAgentProcess } from './agent-process-recognition'
import { pickTuiAgent } from './tui-agent-selection'

describe('Freebuff terminal launches', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'delivers task text through the interactive terminal on %s',
    (platform) => {
      const prompt = '--help\nFix "quoted" paths and $HOME handling'
      const plan = buildAgentStartupPlan({
        agent: 'freebuff',
        prompt,
        cmdOverrides: {},
        platform
      })
      expect(plan).toMatchObject({
        launchCommand: 'freebuff',
        expectedProcess: 'freebuff',
        followupPrompt: prompt
      })
      expect(
        buildAgentDraftLaunchPlan({
          agent: 'freebuff',
          draft: prompt,
          cmdOverrides: {},
          platform
        })
      ).toBeNull()
    }
  )

  it('uses the same launch contract on SSH hosts', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'freebuff',
        prompt: 'Inspect this folder',
        cmdOverrides: {},
        platform: 'linux',
        isRemote: true
      })
    ).toMatchObject({ launchCommand: 'freebuff', followupPrompt: 'Inspect this folder' })
  })

  it.each(['/usr/local/bin/freebuff', 'C:\\tools\\freebuff.exe'])(
    'recognizes %s separately from Codebuff',
    (processName) => {
      expect(recognizeAgentProcess(processName)?.agent).toBe('freebuff')
      expect(isExpectedAgentProcess(processName, 'codebuff')).toBe(false)
    }
  )

  it('honors independent installation and disabled-agent preferences', () => {
    expect(pickTuiAgent('freebuff', ['freebuff', 'codebuff'])).toBe('freebuff')
    expect(pickTuiAgent(null, ['freebuff'])).toBe('freebuff')
    expect(pickTuiAgent('freebuff', ['freebuff', 'codebuff'], ['freebuff'])).toBe('codebuff')
  })
})

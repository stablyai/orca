import { describe, expect, it } from 'vitest'
import {
  recognizeAgentProcessFromCommandLine,
  isExpectedAgentProcess
} from './agent-status/process/agent-process-recognition'
import { getAgentLabel } from './agent-status/title/agent-title-identity'
import { isGeminiTerminalTitle } from './agent-status/title/agent-title-core'
import {
  normalizeTerminalTitle,
  detectAgentStatusFromTitle
} from './agent-status/title/agent-title-status'
import { buildAgentStartupPlan } from './agent-launch/startup/tui-agent-startup'
import { buildAgentResumeStartupPlan } from './agent-launch/startup/tui-agent-resume-startup'

describe('Qoder agent identity and lifecycle', () => {
  it('recognizes the installed versioned binary on native platforms and excludes headless runs', () => {
    for (const command of [
      'qoder',
      '/home/dev/.qoder/entry/qoder',
      'C:\\Qoder\\qoder.cmd',
      'qodercli',
      '/home/dev/.qoder/bin/qodercli/qodercli-1.1.64',
      'C:\\Qoder\\qodercli-1.1.64.exe'
    ]) {
      expect(recognizeAgentProcessFromCommandLine(command)?.agent).toBe('qoder')
      expect(isExpectedAgentProcess(command, 'qodercli')).toBe(true)
      expect(isExpectedAgentProcess(command, 'qoder')).toBe(true)
    }
    expect(recognizeAgentProcessFromCommandLine('qodercli --print hello')).toBeNull()
    for (const args of [
      '-o json',
      '--input-format=stream-json',
      '--remote-control session',
      '--acp',
      '--delete-session 1'
    ]) {
      expect(recognizeAgentProcessFromCommandLine(`qodercli ${args}`)).toBeNull()
    }
    expect(recognizeAgentProcessFromCommandLine('qodercli --prompt-interactive hello')?.agent).toBe(
      'qoder'
    )
    expect(recognizeAgentProcessFromCommandLine('qodercli-unrelated')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('qoder-unrelated')).toBeNull()
  })

  it.each(['qoder', 'qodercli'])(
    'excludes headless %s and preserves interactive resume',
    (command) => {
      for (const args of [
        '--print hello',
        '-p hello',
        '--remote task',
        '--list-sessions',
        '--input-format stream-json',
        '--output-format stream-json',
        '--remote-control session'
      ]) {
        expect(recognizeAgentProcessFromCommandLine(`${command} ${args}`)).toBeNull()
      }
      expect(
        recognizeAgentProcessFromCommandLine(`${command} --resume proof --prompt-interactive hello`)
          ?.agent
      ).toBe('qoder')
    }
  )

  it.each(['ide', 'chat', 'serve-web', 'tunnel', './project', '/home/dev/project', 'C:\\project'])(
    'does not identify qoder %s as an agent',
    (subcommand) => {
      expect(recognizeAgentProcessFromCommandLine(`qoder ${subcommand}`)).toBeNull()
      expect(
        recognizeAgentProcessFromCommandLine(`qoder ${subcommand}`, {
          includeHeadlessOneShot: true
        })
      ).toBeNull()
    }
  )

  it.each([
    ['◇ Qoder CLI | Ready', 'idle'],
    ['✦ Implement feature | Thinking', 'working'],
    ['▲ Implement feature | Confirm', 'permission']
  ] as const)('keeps %s attributed through title storage', (title, status) => {
    const stored = normalizeTerminalTitle(title.padEnd(80))
    expect(getAgentLabel(stored)).toBe('Qoder CLI')
    expect(isGeminiTerminalTitle(title)).toBe(false)
    expect(detectAgentStatusFromTitle(stored)).toBe(status)
    expect(normalizeTerminalTitle(stored)).toBe(stored)
  })
})

it.each(['darwin', 'linux', 'win32'] as const)(
  'launches a Qoder prompt safely on %s',
  (platform) => {
    const plan = buildAgentStartupPlan({
      agent: 'qoder',
      prompt: "fix Bob's branch; echo $HOME",
      cmdOverrides: {},
      platform
    })
    expect(plan?.expectedProcess).toBe('qodercli')
    expect(plan?.followupPrompt).toBeNull()
    expect(plan?.launchCommand).toBe(
      platform === 'win32'
        ? "qodercli --prompt-interactive 'fix Bob''s branch; echo $HOME'"
        : `qodercli --prompt-interactive 'fix Bob'"'"'s branch; echo $HOME'`
    )
  }
)

it('does not rewrite DSH titles containing a pipe as Qoder', () => {
  const title = '✦ 🐋 refactor parser | run tests'
  expect(normalizeTerminalTitle(title)).toBe(title)
  expect(getAgentLabel(title)).not.toBe('Qoder CLI')
  expect(detectAgentStatusFromTitle(title)).not.toBe('working')
})

it.each(['darwin', 'linux', 'win32'] as const)(
  'starts and resumes a configured modern Qoder entry on %s',
  (platform) => {
    const plan = buildAgentStartupPlan({
      agent: 'qoder',
      prompt: 'proof',
      cmdOverrides: { qoder: 'qoder' },
      platform,
      isRemote: platform === 'linux'
    })
    expect(plan?.launchCommand).toBe("qoder --prompt-interactive 'proof'")
    expect(plan?.launchConfig.agentCommand).toBe('qoder')
    const resume = buildAgentResumeStartupPlan({
      agent: 'qoder',
      providerSession: { key: 'session_id', id: 'proof-session' },
      cmdOverrides: {},
      agentCommand: plan?.launchConfig.agentCommand,
      platform,
      isRemote: platform === 'linux'
    })
    expect(resume?.launchCommand).toBe("qoder '--resume' 'proof-session'")
    expect(isExpectedAgentProcess('qodercli-1.1.65', resume?.expectedProcess ?? '')).toBe(true)
  }
)

it.each([
  'qoderclicn',
  'qodercn',
  '/home/test/.qoder-cn/bin/qoderclicn-1.1.65',
  'C:\\Qoder\\qoderclicn.exe'
])('recognizes the China executable %s', (command) => {
  expect(recognizeAgentProcessFromCommandLine(command)?.agent).toBe('qoder-cn')
  expect(recognizeAgentProcessFromCommandLine(`${command} --print hello`)).toBeNull()
})

import { describe, expect, it } from 'vitest'
import { buildAgentResumeStartupPlan } from './tui-agent-startup'

const SESSION = { key: 'session_id' as const, id: '940237d9-c712-48e8-bca1-fd75fc4a8d4b' }

describe('Copilot resume startup plan', () => {
  it('uses the documented joined --resume form', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'copilot',
      providerSession: SESSION,
      cmdOverrides: {},
      agentArgs: '--yolo',
      platform: 'darwin'
    })

    expect(plan?.launchCommand).toBe(`copilot '--yolo' '--resume=${SESSION.id}'`)
  })

  it('quotes the resume argv for cmd.exe', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'copilot',
      providerSession: SESSION,
      cmdOverrides: {},
      agentArgs: '--yolo',
      platform: 'win32',
      shell: 'cmd'
    })

    // Why: cmd.exe treats single quotes as literal characters.
    expect(plan?.launchCommand).toBe(`copilot "--yolo" "--resume=${SESSION.id}"`)
  })

  it('honors a command override', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'copilot',
      providerSession: SESSION,
      cmdOverrides: { copilot: 'copilot --banner' },
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe(`copilot --banner '--resume=${SESSION.id}'`)
  })
})

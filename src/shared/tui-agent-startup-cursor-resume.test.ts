import { describe, expect, it } from 'vitest'
import { buildAgentResumeStartupPlan } from './tui-agent-startup'

const SESSION = { key: 'session_id' as const, id: '668320d2-2fd8-4888-b33c-2a466fec86e7' }

describe('Cursor resume startup plan', () => {
  it('appends the AI Vault --resume form after YOLO args', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'cursor',
      providerSession: SESSION,
      cmdOverrides: {},
      agentArgs: '--yolo',
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe(`cursor-agent '--yolo' '--resume' '${SESSION.id}'`)
  })

  it('quotes the resume argv for cmd.exe', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'cursor',
      providerSession: SESSION,
      cmdOverrides: {},
      agentArgs: '--yolo',
      platform: 'win32',
      shell: 'cmd'
    })

    expect(plan?.launchCommand).toBe(`cursor-agent "--yolo" "--resume" "${SESSION.id}"`)
  })
})

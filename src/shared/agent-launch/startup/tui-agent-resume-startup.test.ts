import { expect, it } from 'vitest'
import { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'

// Enter on Codex's update screen runs a global install and exits; a woken agent's first message is that Enter.
it('resumes Codex with its startup update screen off, from a recorded command too', () => {
  for (const agentCommand of [undefined, 'codex --dangerously-bypass-approvals-and-sandbox']) {
    const resumed = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'thread-1' },
      cmdOverrides: {},
      platform: 'linux',
      shell: 'posix',
      agentCommand
    })
    expect(resumed!.launchCommand).toMatch(
      /check_for_update_on_startup=false'? '?resume'? '?thread-1'?$/
    )
  }
})

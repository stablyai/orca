import { expect, it } from 'vitest'
import { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'

const providerSession = { key: 'session_id', id: 'claude-session-1' } as const

function resumeWithPrompt(
  overrides: Partial<Parameters<typeof buildAgentResumeStartupPlan>[0]> = {}
): string | undefined {
  return buildAgentResumeStartupPlan({
    agent: 'claude',
    providerSession,
    cmdOverrides: {},
    platform: 'linux',
    shell: 'posix',
    prompt: 'Carry on with the task',
    ...overrides
  })?.launchCommand
}

it('passes the prompt as the last argument, after the session, inside the folder change', () => {
  expect(
    resumeWithPrompt({
      providerSession: { ...providerSession, cwd: '/recorded/session' },
      launchCwd: '/tab/start'
    })
  ).toBe("cd '/recorded/session' && claude '--resume' 'claude-session-1' 'Carry on with the task'")
})

it('resumes without the prompt when the command override already passes text after --', () => {
  expect(resumeWithPrompt({ cmdOverrides: { claude: 'claude -- review' } })).toBe(
    "claude '--resume' 'claude-session-1' -- review"
  )
})

it.each([
  ['env -- claude', "env -- claude '--resume' 'claude-session-1' 'Carry on with the task'"],
  ['env -- claude -- review', "env -- claude '--resume' 'claude-session-1' -- review"]
])('reads only a -- after the agent in the wrapper override %s', (override, command) => {
  expect(resumeWithPrompt({ cmdOverrides: { claude: override } })).toBe(command)
})

it('resumes without the prompt an agent that takes its first prompt another way', () => {
  expect(
    resumeWithPrompt({
      agent: 'opencode',
      providerSession: { key: 'session_id', id: 'ses_opencode1' }
    })
  ).toBe("opencode '--session' 'ses_opencode1'")
})

import { describe, expect, it } from 'vitest'
import { dropAgentResumeArgvFromCommand } from './agent-resume-argv-drop'
import { buildAgentResumeStartupPlan } from './tui-agent-startup'

const CODEX_SESSION = {
  key: 'session_id' as const,
  id: '0199aa11-2b3c-4d5e-8f90-a1b2c3d4e5f6'
}

function planFor(platform: NodeJS.Platform, agentArgs?: string): string {
  const plan = buildAgentResumeStartupPlan({
    agent: 'codex',
    providerSession: CODEX_SESSION,
    cmdOverrides: {},
    platform,
    ...(agentArgs ? { agentArgs } : {})
  })
  if (!plan) {
    throw new Error('expected a codex resume plan')
  }
  return plan.launchCommand
}

describe('dropAgentResumeArgvFromCommand', () => {
  it('drops the resume argv the shared builder appended on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const command = planFor(platform)
      expect(command).toContain(CODEX_SESSION.id)
      expect(
        dropAgentResumeArgvFromCommand({
          command,
          agent: 'codex',
          providerSession: CODEX_SESSION
        })
      ).toEqual({ status: 'dropped', command: 'codex' })
    }
  })

  it('keeps the user CLI args that precede the resume argv', () => {
    expect(
      dropAgentResumeArgvFromCommand({
        command: planFor('darwin', '--search'),
        agent: 'codex',
        providerSession: CODEX_SESSION
      })
    ).toEqual({ status: 'dropped', command: "codex '--search'" })
  })

  it('drops an unquoted resume argv from a legacy persisted command', () => {
    expect(
      dropAgentResumeArgvFromCommand({
        command: `codex resume ${CODEX_SESSION.id}`,
        agent: 'codex',
        providerSession: CODEX_SESSION
      })
    ).toEqual({ status: 'dropped', command: 'codex' })
  })

  it('drops the joined Copilot resume token and keeps the user args', () => {
    const providerSession = {
      key: 'session_id' as const,
      id: '940237d9-c712-48e8-bca1-fd75fc4a8d4b'
    }
    const plan = buildAgentResumeStartupPlan({
      agent: 'copilot',
      providerSession,
      cmdOverrides: {},
      agentArgs: '--yolo',
      platform: 'darwin'
    })
    expect(
      dropAgentResumeArgvFromCommand({
        command: plan?.launchCommand ?? '',
        agent: 'copilot',
        providerSession
      })
    ).toEqual({ status: 'dropped', command: "copilot '--yolo'" })
  })

  it('reports absent when the command never carried the resume locator', () => {
    expect(
      dropAgentResumeArgvFromCommand({
        command: 'codex --search',
        agent: 'codex',
        providerSession: CODEX_SESSION
      })
    ).toEqual({ status: 'absent' })
  })

  it('refuses a command whose locator is not the trailing argv', () => {
    // Why: the caller must fail the spawn rather than launch a resume it could not cancel.
    expect(
      dropAgentResumeArgvFromCommand({
        command: `codex resume ${CODEX_SESSION.id} --search`,
        agent: 'codex',
        providerSession: CODEX_SESSION
      })
    ).toEqual({ status: 'unrecognized' })
  })

  it('requires a whitespace boundary so a longer subcommand cannot match', () => {
    expect(
      dropAgentResumeArgvFromCommand({
        command: `codex xresume ${CODEX_SESSION.id}`,
        agent: 'codex',
        providerSession: CODEX_SESSION
      })
    ).toEqual({ status: 'unrecognized' })
  })

  it('does not strip a bare resume argv with no launch command in front of it', () => {
    expect(
      dropAgentResumeArgvFromCommand({
        command: `resume ${CODEX_SESSION.id}`,
        agent: 'codex',
        providerSession: CODEX_SESSION
      })
    ).toEqual({ status: 'unrecognized' })
  })

  it('drops a resume argv left with trailing whitespace by a persisted command', () => {
    // Why: the suffix match is anchored to the end, so an unnormalized command would
    // fall through to `unrecognized` and refuse an otherwise strippable launch.
    expect(
      dropAgentResumeArgvFromCommand({
        command: `codex 'resume' '${CODEX_SESSION.id}'  \n`,
        agent: 'codex',
        providerSession: CODEX_SESSION
      })
    ).toEqual({ status: 'dropped', command: 'codex' })
  })

  it('refuses when the locator also appears outside the trailing resume argv', () => {
    // Why: stripping the suffix would leave the id behind in the cwd, so the launch is
    // not actually resume-free and must not be reported as dropped.
    expect(
      dropAgentResumeArgvFromCommand({
        command: `cd '/tmp/${CODEX_SESSION.id}' && codex 'resume' '${CODEX_SESSION.id}'`,
        agent: 'codex',
        providerSession: CODEX_SESSION
      })
    ).toEqual({ status: 'unrecognized' })
  })

  it('drops the resume argv for the other resumable agents too', () => {
    expect(
      dropAgentResumeArgvFromCommand({
        command: `claude '--resume' '${CODEX_SESSION.id}'`,
        agent: 'claude',
        providerSession: CODEX_SESSION
      })
    ).toEqual({ status: 'dropped', command: 'claude' })
  })
})

import { describe, expect, it } from 'vitest'
import { buildAgentResumeStartupPlan } from './tui-agent-startup'

const ID = 'a4964a7f-fb75-40c0-a9eb-f0755cc54449'

function claudeResume(transcriptPath: string | undefined, shell?: 'posix' | 'powershell' | 'cmd') {
  return buildAgentResumeStartupPlan({
    agent: 'claude',
    providerSession: { key: 'session_id', id: ID, ...(transcriptPath ? { transcriptPath } : {}) },
    cmdOverrides: {},
    agentCommand: "claude '--dangerously-skip-permissions'",
    platform: shell === 'posix' || !shell ? 'darwin' : 'win32',
    ...(shell ? { shell } : {})
  })?.launchCommand
}

describe('Claude resume in the config dir that holds the transcript (#26499)', () => {
  it('prefixes CLAUDE_CONFIG_DIR when the transcript lives outside ~/.claude', () => {
    expect(claudeResume(`/Users/me/.claude-work/projects/-Users-me-app/${ID}.jsonl`)).toBe(
      `CLAUDE_CONFIG_DIR='/Users/me/.claude-work' claude '--dangerously-skip-permissions' '--resume' '${ID}'`
    )
  })

  it('covers a managed account folder too (#24752)', () => {
    const dir = '/home/me/.local/share/orca/claude-accounts/7f7f1e7c/auth'
    expect(claudeResume(`${dir}/projects/-home-me-app/${ID}.jsonl`)).toBe(
      `CLAUDE_CONFIG_DIR='${dir}' claude '--dangerously-skip-permissions' '--resume' '${ID}'`
    )
  })

  it('quotes a config dir with spaces and quotes', () => {
    expect(claudeResume(`/Users/me/Claude Work's/projects/-app/${ID}.jsonl`)).toMatch(
      /^CLAUDE_CONFIG_DIR='\/Users\/me\/Claude Work'.*'s' claude /
    )
  })

  it('leaves the default ~/.claude and a missing transcript path alone', () => {
    const plain = `claude '--dangerously-skip-permissions' '--resume' '${ID}'`
    // Why: setting CLAUDE_CONFIG_DIR to the default dir is not a no-op; Claude then reads
    // .claude.json and the keychain login from another place.
    expect(claudeResume(`/Users/me/.claude/projects/-Users-me-app/${ID}.jsonl`)).toBe(plain)
    expect(claudeResume(undefined)).toBe(plain)
    expect(claudeResume(`/Users/me/.claude-work/sessions/${ID}.jsonl`)).toBe(plain)
  })

  it('does not prefix Windows shells', () => {
    const path = `/Users/me/.claude-work/projects/-app/${ID}.jsonl`
    expect(claudeResume(path, 'powershell')).not.toContain('CLAUDE_CONFIG_DIR')
    expect(claudeResume(path, 'cmd')).not.toContain('CLAUDE_CONFIG_DIR')
  })

  it('applies only to Claude', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: {
        key: 'session_id',
        id: ID,
        transcriptPath: `/Users/me/.claude-work/projects/-app/${ID}.jsonl`
      },
      cmdOverrides: {},
      platform: 'darwin'
    })
    expect(plan?.launchCommand).not.toContain('CLAUDE_CONFIG_DIR')
  })
})

import { expect, it } from 'vitest'
import { aiVaultSessionAfterResumePreparation } from './ai-vault-resume-preparation'
import { buildAiVaultRemoteResumeStartup } from './ai-vault-resume-host-startup'
import {
  buildAiVaultLocalResumeStartup,
  type AiVaultResumeCommandSession
} from './ai-vault-resume-startup'

it.each(['claude', 'codex'] as const)(
  'rebuilds a remote %s resume using the prepared workspace home',
  (agent) => {
    const source: AiVaultResumeCommandSession = {
      agent,
      sessionId: 'saved-session',
      cwd: '/repo',
      codexHome: '/source',
      executionHostId: 'runtime:server',
      executionHostPlatform: 'linux',
      filePath: '/source/sessions/thread.jsonl',
      resumeCommand: 'old-account-command'
    }
    const prepared = aiVaultSessionAfterResumePreparation(source, {
      useRealCodexHome: false,
      workspaceAccountPrepared: true,
      substituteSessionId: 'continued-session',
      resumeReceipt: 'receipt',
      substituteTranscriptPath: '/target/sessions/thread.jsonl',
      ...(agent === 'codex'
        ? { substituteCodexHome: '/target' }
        : { substituteClaudeConfigDir: '/target' })
    })
    expect(buildAiVaultRemoteResumeStartup(prepared, undefined)).toBeNull()
    const startup = buildAiVaultLocalResumeStartup({
      session: prepared,
      host: {
        platform: 'linux',
        agentHostPlatform: 'linux',
        codexHome: agent === 'codex' ? '/target' : null,
        liveShell: 'posix'
      },
      settings: null,
      embedCwd: false
    })
    expect(startup.command).toContain(
      agent === 'codex' ? "CODEX_HOME='/target'" : "CLAUDE_CONFIG_DIR='/target'"
    )
    expect(startup.command).not.toContain('old-account-command')
    expect(startup.command).toContain('continued-session')
    expect(startup.command).not.toContain('saved-session')
    expect(prepared.resumeReceipt).toBe('receipt')
    expect(prepared.filePath).toBe('/target/sessions/thread.jsonl')
  }
)

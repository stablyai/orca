import { describe, expect, it } from 'vitest'
import { buildAiVaultRemoteResumeStartup } from './ai-vault-resume-host-startup'
import type { AiVaultResumeCommandSession } from './ai-vault-resume-startup'

const remoteHost = 'runtime:test-host'
const remoteSession: AiVaultResumeCommandSession = {
  agent: 'pi',
  sessionId: 'sid',
  cwd: '/repo',
  codexHome: null,
  executionHostId: remoteHost,
  executionHostPlatform: 'linux',
  filePath: '/home/u/.pi/agent/sessions/--repo--/s.jsonl',
  resumeCommand: String.raw`cd '/repo' && pi --session '\\wsl.localhost\Ubuntu\home\u\s.jsonl'`
}

describe('buildAiVaultRemoteResumeStartup', () => {
  // The stored line was built with the scanner platform; a WSL target needs its own rebuild.
  it('rebuilds a Pi resume line instead of reusing the scanner platform', () => {
    expect(buildAiVaultRemoteResumeStartup(remoteSession, undefined)).toBeNull()
    expect(
      buildAiVaultRemoteResumeStartup(
        { ...remoteSession, executionHostPlatform: 'win32' },
        undefined
      )
    ).toBeNull()
  })

  it('keeps reusing the scanner line for an agent whose command is platform-neutral', () => {
    const codexSession: AiVaultResumeCommandSession = {
      agent: 'codex',
      sessionId: 'sid',
      cwd: '/repo',
      codexHome: '/home/u/.codex',
      executionHostId: remoteHost,
      executionHostPlatform: 'linux',
      resumeCommand: "cd '/repo' && codex resume 'sid'"
    }
    expect(buildAiVaultRemoteResumeStartup(codexSession, undefined)?.command).toBe(
      "cd '/repo' && codex resume 'sid'"
    )
  })

  it('rebuilds locally scanned sessions for the local platform', () => {
    expect(
      buildAiVaultRemoteResumeStartup({ ...remoteSession, executionHostId: undefined }, undefined)
    ).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { resolveAiVaultContinuationBridge } from './ai-vault-continuation-target'

const CLAUDE_TRANSCRIPT = '/home/marabel/.claude/projects/orca/session.jsonl'

describe('resolveAiVaultContinuationBridge', () => {
  it('keeps the existing same-host path when the session already lives on the target', () => {
    expect(
      resolveAiVaultContinuationBridge({
        sessionFilePath: CLAUDE_TRANSCRIPT,
        sessionExecutionHostId: 'ssh:hetzner',
        targetStatus: 'ssh',
        targetExecutionHostId: 'ssh:hetzner'
      })
    ).toEqual({ kind: 'same-host' })
  })

  it('bridges a local session onto an SSH host by transferring the transcript', () => {
    expect(
      resolveAiVaultContinuationBridge({
        sessionFilePath: CLAUDE_TRANSCRIPT,
        sessionExecutionHostId: 'local',
        targetStatus: 'ssh',
        targetExecutionHostId: 'ssh:hetzner'
      })
    ).toEqual({ kind: 'transfer', sourceConnectionId: null, targetConnectionId: 'hetzner' })
  })

  it('bridges an SSH session back onto the local host', () => {
    expect(
      resolveAiVaultContinuationBridge({
        sessionFilePath: CLAUDE_TRANSCRIPT,
        sessionExecutionHostId: 'ssh:hetzner',
        targetStatus: 'local',
        targetExecutionHostId: 'local'
      })
    ).toEqual({ kind: 'transfer', sourceConnectionId: 'hetzner', targetConnectionId: null })
  })

  it('bridges between two different SSH hosts', () => {
    expect(
      resolveAiVaultContinuationBridge({
        sessionFilePath: CLAUDE_TRANSCRIPT,
        sessionExecutionHostId: 'ssh:hetzner',
        targetStatus: 'ssh',
        targetExecutionHostId: 'ssh:mac-mini'
      })
    ).toEqual({ kind: 'transfer', sourceConnectionId: 'hetzner', targetConnectionId: 'mac-mini' })
  })

  it('treats a session with no recorded host as local', () => {
    expect(
      resolveAiVaultContinuationBridge({
        sessionFilePath: CLAUDE_TRANSCRIPT,
        targetStatus: 'local',
        targetExecutionHostId: 'local'
      })
    ).toEqual({ kind: 'same-host' })
  })

  it('inlines preview text when the session has no stored transcript', () => {
    expect(
      resolveAiVaultContinuationBridge({
        sessionFilePath: '   ',
        sessionExecutionHostId: 'local',
        targetStatus: 'ssh',
        targetExecutionHostId: 'ssh:hetzner'
      })
    ).toEqual({ kind: 'inline', content: 'preview' })
  })

  it('falls back to the vault preview when the source transcript cannot be read', () => {
    expect(
      resolveAiVaultContinuationBridge({
        sessionFilePath: CLAUDE_TRANSCRIPT,
        sessionExecutionHostId: 'runtime:builder',
        targetStatus: 'local',
        targetExecutionHostId: 'local'
      })
    ).toEqual({ kind: 'inline', content: 'preview' })
  })

  it('carries the transcript in the prompt for a paired server, which takes no file', () => {
    expect(
      resolveAiVaultContinuationBridge({
        sessionFilePath: CLAUDE_TRANSCRIPT,
        sessionExecutionHostId: 'local',
        targetStatus: 'runtime',
        targetExecutionHostId: 'runtime:builder'
      })
    ).toEqual({ kind: 'inline', content: 'transcript-tail' })
  })

  it('refuses an unresolved target host', () => {
    expect(
      resolveAiVaultContinuationBridge({
        sessionFilePath: CLAUDE_TRANSCRIPT,
        sessionExecutionHostId: 'local',
        targetStatus: 'unknown',
        targetExecutionHostId: null
      })
    ).toEqual({ kind: 'unavailable', reason: 'target-unsupported' })
  })

  it('does not infer an SSH target with no resolved host id as local', () => {
    expect(
      resolveAiVaultContinuationBridge({
        sessionFilePath: CLAUDE_TRANSCRIPT,
        sessionExecutionHostId: 'local',
        targetStatus: 'ssh',
        targetExecutionHostId: null
      })
    ).toEqual({ kind: 'inline', content: 'transcript-tail' })
  })

  it('never blocks a supported target, so the original flow stays available', () => {
    const targets = [
      { targetStatus: 'local' as const, targetExecutionHostId: 'local' as const },
      { targetStatus: 'ssh' as const, targetExecutionHostId: 'ssh:hetzner' as const },
      { targetStatus: 'runtime' as const, targetExecutionHostId: 'runtime:builder' as const }
    ]
    for (const target of targets) {
      expect(
        resolveAiVaultContinuationBridge({
          sessionFilePath: CLAUDE_TRANSCRIPT,
          sessionExecutionHostId: 'runtime:elsewhere',
          ...target
        }).kind
      ).not.toBe('unavailable')
    }
  })

  it('keeps the WSL carve-out reachable from an SSH shell into this machine', () => {
    expect(
      resolveAiVaultContinuationBridge({
        sessionFilePath: '\\\\wsl.localhost\\Ubuntu\\home\\marabel\\.claude\\session.jsonl',
        sessionExecutionHostId: 'local',
        targetStatus: 'ssh',
        targetExecutionHostId: 'ssh:hetzner'
      })
    ).toEqual({ kind: 'same-host' })
  })
})

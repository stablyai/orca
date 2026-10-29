import { describe, expect, it } from 'vitest'
import {
  ORCHESTRATION_COMPATIBILITY_ATTACHMENT_ENV,
  ORCHESTRATION_COMPATIBILITY_HOST_ID_ENV,
  ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION_ENV,
  ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV,
  readOrchestrationCompatibilityEvidence,
  redactOrchestrationCompatibilitySecrets
} from './orchestration-compatibility-evidence'

describe('orchestration compatibility evidence', () => {
  it('reads inherited pane evidence and a complete runtime-stamped WSL scope', () => {
    expect(
      readOrchestrationCompatibilityEvidence({
        ORCA_TERMINAL_HANDLE: 'term_wsl',
        ORCA_PANE_KEY: 'tab:leaf',
        ORCA_AGENT_LAUNCH_TOKEN: 'launch-secret',
        [ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV]: 'wsl',
        [ORCHESTRATION_COMPATIBILITY_HOST_ID_ENV]: 'local',
        [ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION_ENV]: 'Ubuntu'
      })
    ).toEqual({
      terminalHandle: 'term_wsl',
      paneKey: 'tab:leaf',
      launchToken: 'launch-secret',
      host: { kind: 'wsl', hostId: 'local', distro: 'Ubuntu' }
    })
  })

  it('reads launch proof after provider subprocess environment scrubbing', () => {
    expect(
      readOrchestrationCompatibilityEvidence({
        ORCA_TERMINAL_HANDLE: 'term',
        ORCA_AGENT_PANE: 'tab:leaf',
        ORCA_AGENT_LAUNCH: 'launch'
      })
    ).toEqual({ terminalHandle: 'term', paneKey: 'tab:leaf', launchToken: 'launch' })
  })

  it('rejects partial host stamps instead of accepting caller-chosen scope', () => {
    expect(
      readOrchestrationCompatibilityEvidence({
        ORCA_PANE_KEY: 'tab:leaf',
        [ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV]: 'ssh',
        [ORCHESTRATION_COMPATIBILITY_HOST_ID_ENV]: 'saved-target',
        [ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION_ENV]: 'connection-only'
      })
    ).toEqual({ paneKey: 'tab:leaf' })
  })

  it('redacts evidence from nested CLI error and structured-log values', () => {
    const redacted = redactOrchestrationCompatibilitySecrets({
      compatibilityInvocationId: 'safe-operation-id',
      agentSessionSpawnToken: 'spawn-secret',
      ORCA_AGENT_SESSION_SPAWN_TOKEN: 'spawn-secret',
      ORCA_AGENT_SESSION_PROOF: 'spawn-secret',
      'shell_environment_policy.set.ORCA_AGENT_SESSION_PROOF': 'spawn-secret',
      orchestrationCompatibilityEvidence: {
        launchToken: 'secret',
        host: {
          kind: 'ssh',
          [ORCHESTRATION_COMPATIBILITY_ATTACHMENT_ENV]: 'attachment-secret'
        }
      }
    })

    expect(redacted).toEqual({
      compatibilityInvocationId: 'safe-operation-id',
      agentSessionSpawnToken: '[redacted]',
      ORCA_AGENT_SESSION_SPAWN_TOKEN: '[redacted]',
      ORCA_AGENT_SESSION_PROOF: '[redacted]',
      'shell_environment_policy.set.ORCA_AGENT_SESSION_PROOF': '[redacted]',
      orchestrationCompatibilityEvidence: '[redacted]'
    })
    expect(JSON.stringify(redacted)).not.toContain('secret')
  })

  it('redacts detached SSH attachment proof fields', () => {
    expect(
      redactOrchestrationCompatibilitySecrets({
        host: {
          targetId: 'saved-target',
          connectionIncarnation: 'connection-secret',
          attachmentId: 'attachment-secret'
        }
      })
    ).toEqual({
      host: {
        targetId: 'saved-target',
        connectionIncarnation: '[redacted]',
        attachmentId: '[redacted]'
      }
    })
  })

  it('redacts cyclic arrays without recursing forever', () => {
    const cyclic: unknown[] = []
    cyclic.push(cyclic)

    expect(redactOrchestrationCompatibilitySecrets(cyclic)).toEqual(['[circular]'])
  })
})

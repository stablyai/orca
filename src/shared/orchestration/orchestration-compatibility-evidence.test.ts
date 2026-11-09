import { describe, expect, it } from 'vitest'
import {
  ORCHESTRATION_COMPATIBILITY_ATTACHMENT_ENV,
  redactOrchestrationCompatibilitySecrets
} from './orchestration-compatibility-evidence'

describe('orchestration compatibility evidence', () => {
  it('redacts evidence from nested CLI error and structured-log values', () => {
    const redacted = redactOrchestrationCompatibilitySecrets({
      compatibilityInvocationId: 'safe-operation-id',
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

import { describe, expect, it, vi } from 'vitest'
import { resolveWebRuntimeAuthRejection } from './web-runtime-auth-verdict'
import type {
  WebRuntimeAuthPlan,
  WebRuntimeCredentialSource
} from './web-runtime-credential-source'

const keyPlan: WebRuntimeAuthPlan = {
  kind: 'device-key',
  deviceId: 'mine',
  key: { publicKeyB64: 'k', sign: async () => new Uint8Array(64) }
}

function source(
  revokes = true
): WebRuntimeCredentialSource & { deviceRevoked: ReturnType<typeof vi.fn> } {
  return {
    nextPlan: () => keyPlan,
    migrated: async () => {},
    migrationUnavailable: () => {},
    deviceRevoked: vi.fn(async () => revokes)
  }
}

const rejected = (errorCode: string, errorDeviceId?: string) => ({
  kind: 'rejected' as const,
  type: 'e2ee_error',
  errorCode,
  ...(errorDeviceId ? { errorDeviceId } : {})
})

describe('web auth verdicts (keys are deleted only on a matching device_revoked)', () => {
  it('deletes on device_revoked naming this key', async () => {
    const credential = source()
    expect(
      await resolveWebRuntimeAuthRejection(keyPlan, rejected('device_revoked', 'mine'), credential)
    ).toEqual({ kind: 'failed', reason: 'device-revoked' })
    expect(credential.deviceRevoked).toHaveBeenCalledWith('mine')
  })

  it('keeps the key for another device id, a downgraded host, bad proofs and storage trouble', async () => {
    const credential = source()
    expect(
      await resolveWebRuntimeAuthRejection(keyPlan, rejected('device_revoked', 'other'), credential)
    ).toEqual({ kind: 'failed', reason: 'unauthorized' })
    expect(await resolveWebRuntimeAuthRejection(keyPlan, rejected('bad_auth'), credential)).toEqual(
      {
        kind: 'failed',
        reason: 'device-downgraded'
      }
    )
    expect(
      await resolveWebRuntimeAuthRejection(keyPlan, rejected('bad_proof'), credential)
    ).toEqual({
      kind: 'failed',
      reason: 'unauthorized'
    })
    expect(
      await resolveWebRuntimeAuthRejection(keyPlan, rejected('registry_unavailable'), credential)
    ).toEqual({ kind: 'retry' })
    expect(credential.deviceRevoked).not.toHaveBeenCalled()
  })

  it('explains an insecure-page refusal and keeps token verdicts as before', async () => {
    const tokenPlan: WebRuntimeAuthPlan = { kind: 'legacy-token', deviceToken: 't' }
    expect(
      await resolveWebRuntimeAuthRejection(tokenPlan, rejected('insecure_origin'), source())
    ).toEqual({ kind: 'failed', reason: 'insecure-origin' })
    expect(
      await resolveWebRuntimeAuthRejection(tokenPlan, rejected('device_revoked', 'mine'), source())
    ).toEqual({ kind: 'failed', reason: 'unauthorized' })
  })
})

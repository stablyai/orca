import { REGISTER_DEVICE_KEY_METHOD } from '../../../shared/device-key-capability'
import { encodeDeviceProofMessage } from '../../../shared/device-key-proof'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { decodeBase64Bytes } from '@/lib/base64-bytes'
import type {
  WebRuntimeAuthPlan,
  WebRuntimeCredentialSource
} from './web-runtime-credential-source'

type MigratePlan = Extract<WebRuntimeAuthPlan, { kind: 'migrate' }>

/**
 * Runs on a v2 token socket that just authenticated: checks the host takes device keys, registers
 * this installation's key against this socket's transcript, and records the forked device id.
 * The caller then reconnects with the key. Every failure leaves the token in place.
 */
export async function migrateWebRuntimeToDeviceKey(args: {
  plan: MigratePlan
  transcriptHashB64: string | null
  source: WebRuntimeCredentialSource
  call: (method: string, params?: unknown) => Promise<RuntimeRpcResponse<unknown>>
}): Promise<'migrated' | 'unavailable'> {
  const { plan, source, transcriptHashB64 } = args
  if (!transcriptHashB64) {
    source.migrationUnavailable()
    return 'unavailable'
  }
  try {
    const status = await args.call('status.get')
    const capabilities = status.ok ? readCapabilities(status.result) : []
    if (!plan.requiredCapabilities.every((capability) => capabilities.includes(capability))) {
      source.migrationUnavailable()
      return 'unavailable'
    }
    const proof = await plan.key.sign(
      encodeDeviceProofMessage('register', decodeBase64Bytes(transcriptHashB64))
    )
    const registered = await args.call(REGISTER_DEVICE_KEY_METHOD, {
      devicePublicKeyB64: plan.key.publicKeyB64,
      deviceProofB64: bytesToBase64(proof),
      deviceLabel: webDeviceLabel(),
      ...(plan.ephemeral ? { ephemeral: true } : {})
    })
    const deviceId = registered.ok ? readDeviceId(registered.result) : null
    if (!deviceId) {
      source.migrationUnavailable()
      return 'unavailable'
    }
    await source.migrated(plan, deviceId)
    return 'migrated'
  } catch (error) {
    console.warn('[web] Device key registration failed; staying on the pairing code.', error)
    source.migrationUnavailable()
    return 'unavailable'
  }
}

function readCapabilities(result: unknown): string[] {
  if (!result || typeof result !== 'object' || !('capabilities' in result)) {
    return []
  }
  const capabilities = result.capabilities
  return Array.isArray(capabilities)
    ? capabilities.filter((capability): capability is string => typeof capability === 'string')
    : []
}

function readDeviceId(result: unknown): string | null {
  if (!result || typeof result !== 'object' || !('deviceId' in result)) {
    return null
  }
  return typeof result.deviceId === 'string' && result.deviceId ? result.deviceId : null
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function webDeviceLabel(): string {
  return typeof navigator === 'undefined' ? 'Web browser' : `Web browser (${navigator.platform})`
}

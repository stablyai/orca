import type { BrowserHostLeaseAuthority } from '../../../shared/browser/client-hosting/browser-client-host-protocol'
import { invokeNative } from './tauri-native-host'

// Client-route partition naming for pages this desktop hosts for a paired
// server. The host-owned Rust binding is environment-scoped and
// conflict-checked; the renderer-local derivation below is only a fallback
// for non-native bridges and tests.

function hashExecutionHostKey(value: string): string {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function deriveTauriBrowserClientPartition(
  browserProfileId: string,
  executionHostKey: string
): string {
  const profile = browserProfileId.replaceAll(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64) || 'default'
  return `persist:tauri-browser-${profile}-${hashExecutionHostKey(executionHostKey)}`
}

export type TauriClientRoutePartition = {
  partition: string
  bindingFingerprint: string
}

export async function resolveTauriBrowserClientPartition(
  environmentId: string,
  browserProfileId: string,
  executionHostKey: string
): Promise<string> {
  try {
    const resolved = await invokeNative<TauriClientRoutePartition>(
      'poc_browser_client_route_resolve_partition',
      { args: { environmentId, profileId: browserProfileId, executionHostKey } }
    )
    if (
      resolved &&
      typeof resolved.partition === 'string' &&
      resolved.partition.startsWith('persist:')
    ) {
      return resolved.partition
    }
  } catch {
    // Fall through to the renderer-local derivation below.
  }
  return deriveTauriBrowserClientPartition(browserProfileId, executionHostKey)
}

export function noteTauriBrowserClientRouteAuthority(
  environmentId: string,
  authority: BrowserHostLeaseAuthority,
  executionHostKey: string
): void {
  void invokeNative<boolean>('poc_browser_client_route_note_authority', {
    args: {
      environmentId,
      authorityRuntimeId: authority.authorityRuntimeId,
      authorityEpoch: authority.authorityEpoch,
      browserHostClientId: authority.browserHostClientId,
      browserHostGeneration: authority.browserHostGeneration,
      executionHostKey
    }
  }).catch(() => {})
}

export function clearTauriBrowserClientRouteAuthority(environmentId: string): void {
  void invokeNative<boolean>('poc_browser_client_route_close_authority', {
    args: { environmentId }
  }).catch(() => {})
}

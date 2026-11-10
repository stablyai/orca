import type { PlatformBindings } from './types'

export function platformBindings(bindings: readonly string[]): PlatformBindings {
  return {
    darwin: bindings,
    linux: bindings,
    win32: bindings
  }
}

/** ⇧⌘N for New cloud workspace, pending Neil's Q2 (vs ⌥⌘N): change it here. */
export const NEW_CLOUD_WORKSPACE_BINDING = 'Mod+Shift+N'

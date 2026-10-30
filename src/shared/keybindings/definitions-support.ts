import type { PlatformBindings } from './types'

export function platformBindings(bindings: readonly string[]): PlatformBindings {
  return {
    darwin: bindings,
    linux: bindings,
    win32: bindings
  }
}

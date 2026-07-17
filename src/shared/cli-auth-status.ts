export type CliAuthState = 'authenticated' | 'unauthenticated' | 'timeout' | 'unreachable' | 'error'

export type CliAuthStatus = {
  installed: boolean
  authenticated: boolean
  /** Optional so renderer/preload compatibility survives mixed app/runtime versions. */
  authState?: CliAuthState
}

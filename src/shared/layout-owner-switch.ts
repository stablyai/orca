// The one read of the ORCA_LAYOUT_OWNER build switch: 'main' turns on the dark path where main
// decides every layout change. Off in every shipped build; deleted with the old path (phase F).
// Every switch point branches on ORCA_LAYOUT_OWNER_IS_MAIN, so grep finds them all.

/** Substituted by electron.vite.config.ts; absent (off) in tests, the CLI and the web client. */
declare const ORCA_LAYOUT_OWNER: 'window' | 'main' | undefined

export const ORCA_LAYOUT_OWNER_IS_MAIN =
  // oxlint-disable-next-line unicorn/no-typeof-undefined -- undeclared outside electron-vite builds; a bare read throws.
  typeof ORCA_LAYOUT_OWNER !== 'undefined' && ORCA_LAYOUT_OWNER === 'main'

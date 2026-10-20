// The one read of the ORCA_LAYOUT_OWNER build switch: 'main' turns on the path where main decides
// every layout change. On in the shipped desktop app; 'window' builds the rollback variant, and the
// orcad server keeps it off. Deleted with the old path (phase F).
// Every switch point branches on ORCA_LAYOUT_OWNER_IS_MAIN, so grep finds them all.

/**
 * Defined by the desktop build (its renderer is also the shipped web client) and vitest; absent
 * (off) in orcad, the CLI and the `pnpm build:web` dev client.
 */
declare const ORCA_LAYOUT_OWNER: 'window' | 'main' | undefined

export const ORCA_LAYOUT_OWNER_IS_MAIN =
  // oxlint-disable-next-line unicorn/no-typeof-undefined -- undeclared outside electron-vite builds; a bare read throws.
  typeof ORCA_LAYOUT_OWNER !== 'undefined' && ORCA_LAYOUT_OWNER === 'main'

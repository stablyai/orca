/** What `relay.js --orca-runtime-selftest <nonce>` prints, shared by the relay and the client. */

export const RELAY_RUNTIME_SELF_TEST_FLAG = '--orca-runtime-selftest'
export const RELAY_RUNTIME_SELF_TEST_PREFIX = 'ORCA_RUNTIME_SELFTEST '

export type RelayRuntimeKind = 'pinned-node' | 'host-node'

export type RelayRuntimeSelfTestReport = {
  nonce: string
  node: string
  napi: string | null
  /** Null on musl, non-Linux, and unreadable reports. */
  glibcVersionRuntime: string | null
  runtime: RelayRuntimeKind
} & ({ ok: true } | { ok: false; stage: 'load' | 'spawn'; error: string })

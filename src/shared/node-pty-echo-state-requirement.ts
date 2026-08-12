/**
 * Decides whether the loaded node-pty really carries Orca's `echoState` binding, and
 * how strict the suites that depend on it are about its absence.
 *
 * Why this is not "is the sync probe defined": the JS half of the patch ships in the
 * pnpm patch, so `createPtySlaveEchoSyncProbe` hands back a probe as soon as
 * node_modules is patched — even when the loaded NATIVE module is the upstream
 * prebuild, whose exports are ['fork', 'open', 'resize', 'process']. `readEchoState()`
 * then answers undefined, the probe maps it to 'unknown', #13892's same-turn fast path
 * never fires, and a suite that only checked the probe exists would pass with the fix
 * switched off.
 */

/** Env var CI sets to make a prebuilt or stale node-pty fail instead of skip. */
export const REQUIRE_NODE_PTY_ECHO_STATE_ENV_VAR = 'ORCA_REQUIRE_NODE_PTY_ECHO_STATE'

/** Spelled out because `pnpm rebuild node-pty` finds the shipped darwin prebuild and exits 0. */
export const NODE_PTY_SOURCE_BUILD_HINT =
  'Build node-pty from source with `npm_config_build_from_source=true pnpm rebuild node-pty` or `node config/scripts/rebuild-native-deps.mjs`; plain `pnpm rebuild node-pty` is not enough on macOS, where it finds the shipped darwin prebuild and exits 0.'

export type NodePtyEchoStateLookup =
  | { available: true; nativeExports: readonly string[] }
  | { available: false; nativeExports: readonly string[]; reason: string }

/** Pass the already-imported `node-pty` module; it exposes the raw binding as `native`. */
export function resolveNodePtyEchoStateSupport(
  nodePtyModule: unknown,
  platform: NodeJS.Platform = process.platform
): NodePtyEchoStateLookup {
  const native = (nodePtyModule as { native?: unknown } | null | undefined)?.native
  if (typeof native !== 'object' || native === null) {
    return {
      available: false,
      nativeExports: [],
      reason:
        platform === 'win32'
          ? 'ConPTY has no slave line discipline to read, so node-pty exposes no native binding'
          : `node-pty exposed no native binding to read echoState from. ${NODE_PTY_SOURCE_BUILD_HINT}`
    }
  }
  const nativeExports = Object.keys(native as Record<string, unknown>)
  if (typeof (native as Record<string, unknown>).echoState !== 'function') {
    return {
      available: false,
      nativeExports,
      reason: `the loaded node-pty native binding exports [${nativeExports.join(', ')}] and has no echoState, so it is an upstream prebuild rather than a build of Orca's patch — every sync probe would answer 'unknown' and #13892's same-turn reply would be off. ${NODE_PTY_SOURCE_BUILD_HINT}`
    }
  }
  return { available: true, nativeExports }
}

/**
 * The message to fail with when CI demanded a source-built node-pty and did not get
 * one, else null.
 *
 * Assert this in a test that always runs, so the requirement cannot vanish with the
 * suite it guards.
 */
export function nodePtyEchoStateRequirementViolation(
  lookup: NodePtyEchoStateLookup,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (lookup.available || env[REQUIRE_NODE_PTY_ECHO_STATE_ENV_VAR] !== '1') {
    return null
  }
  return `${REQUIRE_NODE_PTY_ECHO_STATE_ENV_VAR}=1 but the patched-node-pty tests would skip: ${lookup.reason}`
}

/** Debugger trust and adapter locations; an adapter starts only for an enabled repo and an approved key. */
export type DebugSettings = {
  /** Repos whose debug adapters may start; enabling one names the exact binaries first. */
  debugEnabledRepos: string[]
  /** repoId → approved `debugAdapterApprovalKey`s; a changed binary or args needs a new approval. */
  debugAdapterApprovals: Record<string, string[]>
  /** Interpreter that runs debugpy when the launch config names none; empty means auto. */
  debugPythonPath: string
  /** js-debug's `dapDebugServer.js`; empty means $XDG_DATA_HOME/js-debug/src/dapDebugServer.js. */
  debugJsDebugServerPath: string
  /** repoId → approved launch configurations. */
  debugLaunchApprovals: Record<string, string[]>
}

/** Consent is for this exact (adapter, resolved binary, args); main spawns only an approved key. */
export function debugAdapterApprovalKey(
  adapterId: string,
  binaryPath: string,
  args: readonly string[]
): string {
  return JSON.stringify([adapterId, binaryPath, ...args])
}

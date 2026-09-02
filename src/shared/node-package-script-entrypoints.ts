/** Package dirs (forward-slash, lowercase) whose scripts are the agent, keyed by process name. */
export const NODE_PACKAGE_SCRIPT_ENTRYPOINTS: Record<string, readonly string[]> = {
  codex: ['node_modules/@openai/codex/'],
  gemini: ['node_modules/@google/gemini-cli/'],
  // Why: ZCode's npm bin is `dist/zcode.cjs`, so a package install runs as `node …zcode.cjs`
  // and never shows `zcode` as the foreground name (a SEA build still matches by name).
  zcode: ['node_modules/@zcode/cli/'],
  bob: ['node_modules/bobshell/']
}

/** Why a segment boundary: `fake-node_modules/bobshell/` is not the package. */
export function isNodePackageScriptPath(
  comparablePath: string,
  markers: readonly string[]
): boolean {
  return markers.some(
    (marker) => comparablePath.startsWith(marker) || comparablePath.includes(`/${marker}`)
  )
}

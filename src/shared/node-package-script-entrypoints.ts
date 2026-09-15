/** Package dirs (forward-slash, lowercase) whose scripts are the agent, keyed by process name. */
export const NODE_PACKAGE_SCRIPT_ENTRYPOINTS: Record<string, readonly string[]> = {
  codex: ['node_modules/@openai/codex/'],
  gemini: ['node_modules/@google/gemini-cli/'],
  bob: ['node_modules/bobshell/']
}

/** Unquoted, lowercased, forward-slash form so one rule matches every platform's paths. */
export function comparableScriptPath(token: string): string {
  return token
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .toLowerCase()
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

// Node CLIs whose shim launches a script named after the agent, but generic enough that
// the basename alone is not identity (`dsh-tui.js` could be anyone's file). The package
// directory in the resolved path is what makes the match authoritative.
//
// Split out of agent-process-recognition.ts so the recognizer keeps only its logic and a
// new agent's install path is a data edit, as in agent-node-entrypoint-identities.ts.
export const NODE_PACKAGE_SCRIPT_ENTRYPOINTS: Record<string, readonly string[]> = {
  codex: ['node_modules/@openai/codex/'],
  codebuddy: ['node_modules/@tencent-ai/codebuddy-code/'],
  gemini: ['node_modules/@google/gemini-cli/'],
  // Why: ZCode's npm bin is `dist/zcode.cjs`, so a package install runs as `node …zcode.cjs`
  // and never shows `zcode` as the foreground name (a SEA build still matches by name).
  zcode: ['node_modules/@zcode/cli/'],
  // Why: the `dsh-tui` launcher is installed twice — once on PATH and once inside the
  // profile it bootstraps — and the PATH copy re-execs the profile copy by absolute path.
  'dsh-tui': ['node_modules/@deepseek-harness-tui/dsh-tui/'],
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

/** Codex options whose value is the next token, so a subcommand search must skip it. */
export const CODEX_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-c',
  '--config',
  '--enable',
  '--disable',
  '-m',
  '--model',
  '--local-provider'
])

/** Value options a structured launch drops: Orca sets permissions, profile and directories itself. */
export const CODEX_DROPPED_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-a',
  '--ask-for-approval',
  '-s',
  '--sandbox',
  '-p',
  '--profile',
  '-C',
  '--cd',
  '--add-dir',
  '-i',
  '--image'
])

/** Remote options, which take a value. */
export const CODEX_REMOTE_OPTIONS: ReadonlySet<string> = new Set([
  '--remote',
  '--remote-auth-token-env'
])

/** Switches a structured launch drops; they take no value. */
export const CODEX_DROPPED_SWITCHES: ReadonlySet<string> = new Set([
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--approve-for-me',
  '--not-so-yolo',
  '--dangerously-bypass-hook-trust',
  '--worktree',
  '--strict-config',
  '--help',
  '-h',
  '--version',
  '-V'
])

/** Switches a structured launch keeps; they take no value. */
export const CODEX_PASSTHROUGH_SWITCHES: ReadonlySet<string> = new Set([
  '--search',
  '--oss',
  '--no-alt-screen',
  '--no-daemon'
])

/** The option a token names: `--name=value` and attached short values (`-mo3`) name their option. */
export function codexOptionName(token: string): string {
  if (token.startsWith('--')) {
    return token.split('=', 1)[0]
  }
  if (/^-[acmspiC].+/.test(token)) {
    return token.slice(0, 2)
  }
  return token
}

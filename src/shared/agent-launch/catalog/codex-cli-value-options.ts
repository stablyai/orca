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

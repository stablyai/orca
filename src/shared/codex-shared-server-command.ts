// Mirror tui/src/daemon_startup.rs exclusion conservatively: all -c/--enable/--disable skip warnings, avoiding false positives.
const EMBEDDED_FLAGS: ReadonlySet<string> = new Set([
  '--no-daemon',
  '--oss',
  '--remote',
  '--profile',
  '-p',
  '--strict-config',
  '--dangerously-bypass-hook-trust',
  '--search',
  '--approve-for-me',
  '--not-so-yolo',
  '--enable',
  '--disable',
  '--config',
  '-c'
])

// All cli/src/main.rs subcommands except shared-server TUI resume/fork/agents.
const NON_TUI_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'exec',
  'e',
  'review',
  'login',
  'logout',
  'mcp',
  'plugin',
  'app-server',
  'remote-control',
  'app',
  'completion',
  'update',
  'doctor',
  'sandbox',
  'debug',
  'execpolicy',
  'apply',
  'a',
  'queue',
  'archive',
  'delete',
  'migrate-rollouts',
  'unarchive',
  'cloud',
  'cloud-tasks',
  'responses-api-proxy',
  'stdio-to-uds',
  'exec-server',
  'features',
  'tcp-tunnel',
  'help'
])

// Flags that never take a value, so the word after one is still the first positional.
const VALUELESS_FLAGS: ReadonlySet<string> = new Set([
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--no-alt-screen',
  '--worktree'
])

// The program word: `codex`, `codex.exe`, the npm `codex.js` launcher, or a platform binary.
const CODEX_PROGRAM_RE = /(?:^|[\\/])codex(?:\.(?:js|mjs|cjs|exe|cmd)|-[^\\/]+)?$/i

function isEmbeddedFlag(word: string): boolean {
  const name = word.split('=', 1)[0] ?? word
  // Why the prefix check: clap also accepts a short flag glued to its value (`-pwork`, `-cx=1`).
  return EMBEDDED_FLAGS.has(name) || /^-[pc][^-]/.test(word)
}

/** Detect interactive shared-server clients from process text. Group double-quoted paths, never apostrophes in prompts (don't). Invisible env opt-outs may cause rare false banners. */
export function codexCommandLineJoinsSharedServer(commandLine: string): boolean {
  const words = (commandLine.match(/"[^"]*"|\S+/g) ?? []).map((word) =>
    word.replace(/^["']+|["']+$/g, '')
  )
  const programIndex = words.findIndex((word) => CODEX_PROGRAM_RE.test(word))
  if (programIndex === -1) {
    return false
  }
  const args = words.slice(programIndex + 1)
  if (args.some(isEmbeddedFlag)) {
    return false
  }
  // Why only the first positional: clap reads a subcommand there, and later words are prompt text.
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]
    if (word.startsWith('-')) {
      continue
    }
    if (NON_TUI_SUBCOMMANDS.has(word)) {
      return false
    }
    const previous = args[index - 1]
    // Why check one more: this word may be the previous flag's value (`-m gpt-5 exec`).
    if (!previous?.startsWith('-') || previous.includes('=') || VALUELESS_FLAGS.has(previous)) {
      return true
    }
  }
  return true
}

export const CODEX_SHARED_SERVER_FEATURE_KEY = 'daemon_auto_start'
/** The fix's commands, as argv after the `codex` program. */
export const CODEX_DISABLE_SHARED_SERVER_ARGS = [
  'features',
  'disable',
  CODEX_SHARED_SERVER_FEATURE_KEY
] as const
export const CODEX_STOP_SHARED_SERVER_ARGS = ['app-server', 'daemon', 'stop'] as const
/** What the fix dialog shows the user it runs. */
export const CODEX_DISABLE_AUTO_START_COMMAND = `codex ${CODEX_DISABLE_SHARED_SERVER_ARGS.join(' ')}`
export const CODEX_STOP_SHARED_SERVER_COMMAND = `codex ${CODEX_STOP_SHARED_SERVER_ARGS.join(' ')}`

/** Whether a local pane's Codex is a client of Codex's shared server. */
export type CodexSharedServerStatus =
  | { joined: false }
  | {
      joined: true
      /** The pane's shell lacks the codex function a new terminal would give it. */
      openedBeforeWrapper: boolean
    }

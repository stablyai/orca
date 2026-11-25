import {
  comparablePath,
  findInterpreterEntrypointToken,
  isInterpreterProcessName
} from './agent-command-line-entrypoint'

const VALUE_OPTIONS = new Set([
  '--cwd',
  '--preset',
  '--base-url',
  '--session',
  '--worktree-ref',
  '--effort',
  '--model',
  '-m',
  '--rules',
  '--append-system-prompt',
  '--system-prompt',
  '--system-prompt-override',
  '--permission-mode',
  '--output-format',
  '--json-schema',
  '--allow',
  '--allowedTools',
  '--deny',
  '--disallowedTools',
  '--reasoning-effort',
  '--compaction-mode',
  '--compaction-detail',
  '--load',
  '--session-id',
  '-s',
  '--ref',
  '--agent',
  '--agents',
  '--tools',
  '--disallowed-tools',
  '--max-turns',
  '--background-wait-timeout',
  '--sandbox',
  '--storage-mode',
  '--client-identifier',
  '--hunk-tracker-mode',
  '--installer',
  '--debug-file',
  '--leader-socket'
])

const OPTIONAL_VALUE_OPTIONS = new Set(['--resume', '-r', '--worktree', '-w'])

const ONE_SHOT_OPTIONS = new Set(['-p', '--single', '--print', '--prompt-json', '--prompt-file'])

function isDsbScriptEntrypoint(token: string): boolean {
  const base = token.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  return (
    base === 'dsb.js' || base === 'dsb.mjs' || base === 'dsb.cjs' || base === 'deepseek-build.js'
  )
}

// Outer `agent` forwards native one-shot flags; preload arguments precede npm shims.
export function isDsbHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  const command =
    comparablePath(tokens[0] ?? '')
      .split('/')
      .pop()
      ?.replace(/\.(?:exe|cmd|bat|ps1)$/i, '') ?? ''
  let commandIndex = 0
  if (isInterpreterProcessName(command)) {
    const entrypoint = findInterpreterEntrypointToken([...tokens], command)
    if (!entrypoint || !isDsbScriptEntrypoint(entrypoint)) {
      return false
    }
    commandIndex = tokens.indexOf(entrypoint, 1)
  }
  let forwardsNativeArgs = false
  let outerCommandSeen = command === 'deepseek-build-agent'
  let outerSeparatorConsumed = false
  for (let index = commandIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) {
      return false
    }
    if (token === '--') {
      // Outer trailing_var_arg consumes its first separator before native parsing.
      if (forwardsNativeArgs && !outerSeparatorConsumed) {
        outerSeparatorConsumed = true
        continue
      }
      return false
    }
    const name = token.split('=', 1)[0]
    if (ONE_SHOT_OPTIONS.has(name) || /^-c*p/.test(token)) {
      return true
    }
    if (VALUE_OPTIONS.has(name) && !token.includes('=')) {
      index += 1
      continue
    }
    if (
      OPTIONAL_VALUE_OPTIONS.has(name) &&
      !token.includes('=') &&
      tokens[index + 1] &&
      !tokens[index + 1].startsWith('-')
    ) {
      index += 1
      continue
    }
    if (token.startsWith('-')) {
      continue
    }
    if (token === 'agent' && !outerCommandSeen) {
      forwardsNativeArgs = true
      outerCommandSeen = true
      continue
    }
    if (!outerCommandSeen) {
      return token === 'run'
    }
  }
  return false
}

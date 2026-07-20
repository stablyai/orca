export type ParsedArgs = {
  commandPath: string[]
  flags: Map<string, string | boolean>
  positionalFlagConflicts?: string[]
}

export const GLOBAL_FLAGS = ['help', 'json', 'pairing-code', 'environment']
export const GLOBAL_VALUE_FLAGS = new Set(['pairing-code', 'environment'])
export const BOOLEAN_FLAGS = new Set([
  'all',
  'attachments',
  'children',
  'comments',
  'connect',
  'current',
  'dry-run',
  'enter',
  'focus',
  'force',
  'full',
  'help',
  'inject',
  'interrupt',
  'json',
  'messages',
  'me',
  'mobile',
  'mobile-pairing',
  'no-pairing',
  'parent-current',
  'provision',
  'ready',
  'recipe-json',
  'relations',
  'reinstall',
  'restore-window',
  'return-preamble',
  'run-hooks',
  'show-profile',
  'staged',
  'tab',
  'tasks',
  'text-stdin',
  'unread',
  'value-stdin',
  'wait'
])

export const REPEATED_FLAG_SEPARATOR = '\u0000'
const REPEATABLE_STRING_FLAGS = new Set(['label'])

function setFlagValue(flags: Map<string, string | boolean>, name: string, value: string): void {
  const existing = flags.get(name)
  if (typeof existing === 'string' && REPEATABLE_STRING_FLAGS.has(name)) {
    flags.set(name, `${existing}${REPEATED_FLAG_SEPARATOR}${value}`)
    return
  }
  flags.set(name, value)
}

function commandPathStartsAt(argv: string[], tokenIndex: number, path: string[]): boolean {
  let cursor = tokenIndex
  for (const part of path) {
    while (argv[cursor]?.startsWith('--')) {
      const assignment = argv[cursor].slice(2)
      const flag = assignment.split('=', 1)[0]
      cursor += assignment.includes('=') || BOOLEAN_FLAGS.has(flag) ? 1 : 2
    }
    if (argv[cursor] !== part) {
      return false
    }
    cursor += 1
  }
  return true
}

export function parseArgs(argv: string[], commandPaths?: readonly string[][]): ParsedArgs {
  const commandPath: string[] = []
  const flags = new Map<string, string | boolean>()

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      commandPath.push(token)
      continue
    }

    const assignment = token.slice(2)
    // Why: `--flag=value` is the only unambiguous way to pass a value starting with `--`.
    const equalsIndex = assignment.indexOf('=')
    if (equalsIndex !== -1) {
      setFlagValue(flags, assignment.slice(0, equalsIndex), assignment.slice(equalsIndex + 1))
      continue
    }

    const flag = assignment
    if (BOOLEAN_FLAGS.has(flag)) {
      flags.set(flag, true)
      continue
    }
    // Why: a pre-command flag must not consume a registry-resolvable command path.
    const startsCommandAt = (tokenIndex: number): boolean =>
      commandPaths?.some((path) => commandPathStartsAt(argv, tokenIndex, path)) ?? false
    if (commandPath.length === 0 && startsCommandAt(i + 1) && !startsCommandAt(i + 2)) {
      flags.set(flag, true)
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      flags.set(flag, true)
      continue
    }
    setFlagValue(flags, flag, next)
    i += 1
  }

  return { commandPath, flags }
}

export function matches(actual: string[], expected: string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  )
}

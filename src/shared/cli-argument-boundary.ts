export const CLI_GLOBAL_VALUE_FLAGS: readonly string[] = ['pairing-code', 'environment']
export const CLI_GLOBAL_FLAGS: readonly string[] = ['help', 'json', ...CLI_GLOBAL_VALUE_FLAGS]

export const CLI_BOOLEAN_FLAGS = new Set([
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
  'include-archived',
  'include-remote',
  'include-visual-layouts',
  'interrupt',
  'json',
  'local',
  'messages',
  'me',
  'mobile',
  'mobile-pairing',
  'no-pairing',
  'screen',
  'parent-current',
  'provision',
  'ready',
  'recipe-json',
  'references',
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

function commandPathStartsAt(
  argv: readonly string[],
  tokenIndex: number,
  path: readonly string[],
  booleanFlags: ReadonlySet<string>
): boolean {
  let cursor = tokenIndex
  for (const part of path) {
    while (argv[cursor]?.startsWith('--')) {
      const assignment = argv[cursor].slice(2)
      const flag = assignment.split('=', 1)[0]
      cursor += assignment.includes('=') || booleanFlags.has(flag) ? 1 : 2
    }
    if (argv[cursor] !== part) {
      return false
    }
    cursor += 1
  }
  return true
}

export function findCliCommandIndex(
  argv: readonly string[],
  commandPaths: readonly (readonly string[])[],
  knownValueFlags: readonly string[] = [],
  // Why: per-command value-less flags decide where a command path begins, so the
  // boundary and the parser must read one set. Callers that know the resolved
  // specs widen this; the rest get the global set.
  booleanFlags: ReadonlySet<string> = CLI_BOOLEAN_FLAGS
): number {
  const startsCommandAt = (index: number): boolean =>
    commandPaths.some((path) => commandPathStartsAt(argv, index, path, booleanFlags))

  for (let index = 0; index < argv.length;) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      return startsCommandAt(index) ? index : -1
    }

    const assignment = token.slice(2)
    const flag = assignment.split('=', 1)[0]
    const next = argv[index + 1]
    const takesNext =
      !assignment.includes('=') &&
      !booleanFlags.has(flag) &&
      next !== undefined &&
      !next.startsWith('--') &&
      (knownValueFlags.includes(flag) ||
        !(startsCommandAt(index + 1) && !startsCommandAt(index + 2)))

    index += takesNext ? 2 : 1
  }
  return -1
}

/** The longest registered command path that begins at `index`, or null. */
export function findCliCommandPathAt(
  argv: readonly string[],
  commandPaths: readonly (readonly string[])[],
  index: number,
  booleanFlags: ReadonlySet<string> = CLI_BOOLEAN_FLAGS
): readonly string[] | null {
  let longest: readonly string[] | null = null
  for (const path of commandPaths) {
    if (
      commandPathStartsAt(argv, index, path, booleanFlags) &&
      (!longest || path.length > longest.length)
    ) {
      longest = path
    }
  }
  return longest
}

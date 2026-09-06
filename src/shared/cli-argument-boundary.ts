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
  path: readonly string[]
): boolean {
  let cursor = tokenIndex
  for (const part of path) {
    while (argv[cursor]?.startsWith('--')) {
      const assignment = argv[cursor].slice(2)
      const flag = assignment.split('=', 1)[0]
      cursor += assignment.includes('=') || CLI_BOOLEAN_FLAGS.has(flag) ? 1 : 2
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
  knownValueFlags: readonly string[] = []
): number {
  const startsCommandAt = (index: number): boolean =>
    commandPaths.some((path) => commandPathStartsAt(argv, index, path))

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
      !CLI_BOOLEAN_FLAGS.has(flag) &&
      next !== undefined &&
      !next.startsWith('--') &&
      (knownValueFlags.includes(flag) ||
        !(startsCommandAt(index + 1) && !startsCommandAt(index + 2)))

    index += takesNext ? 2 : 1
  }
  return -1
}

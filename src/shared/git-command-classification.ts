/** Run WSL Git reads directly with explicit PATH/HOME so login-shell rc/motd cannot corrupt parsed stdout.
 * Writes/network retain the login shell for profile-provided credential helpers, ssh-agent and environment. */

const ALWAYS_READ_SUBCOMMANDS = new Set([
  'blame',
  'cat-file',
  'check-ref-format',
  'check-ignore',
  'describe',
  'diff',
  'diff-tree',
  'for-each-ref',
  'log',
  'ls-files',
  'ls-tree',
  'merge-base',
  'name-rev',
  'rev-list',
  'rev-parse',
  'show',
  'show-ref',
  'status',
  'var'
])

// Read markers that appear as a flag anywhere after the subcommand.
const READ_FLAG_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  branch: new Set([
    '--list',
    '-l',
    '--show-current',
    '--contains',
    '--points-at',
    '--all',
    '-a',
    '--remotes',
    '-r'
  ]),
  config: new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l'])
}

const BRANCH_MUTATION_FLAGS = new Set([
  '--copy',
  '--create-reflog',
  '--delete',
  '--edit-description',
  '--force',
  '--move',
  '--no-create-reflog',
  '--no-track',
  '--recurse-submodules',
  '--set-upstream-to',
  '--track',
  '--unset-upstream'
])
const BRANCH_MUTATION_SHORT_FLAGS = new Set(['c', 'C', 'd', 'D', 'f', 'm', 'M', 't', 'u'])

function hasBranchMutationFlag(args: readonly string[]): boolean {
  return args.some((arg) => {
    const flag = arg.split('=')[0]
    if (BRANCH_MUTATION_FLAGS.has(flag)) {
      return true
    }
    return (
      /^-[^-]/.test(flag) &&
      flag
        .slice(1)
        .split('')
        .some((part) => BRANCH_MUTATION_SHORT_FLAGS.has(part))
    )
  })
}

// Match actions only at the first non-flag argument; worktree remove list may delete a worktree named list.
const READ_ACTION_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  remote: new Set(['get-url']),
  submodule: new Set(['status']),
  worktree: new Set(['list'])
}

// Subcommands whose action-less form only lists (`git remote`, `git submodule`).
const BARE_FORM_IS_READ = new Set(['remote', 'submodule'])

export const GIT_GLOBAL_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
  '--exec-path'
])

/** Leading global options and their values precede the subcommand. */
export function findGitSubcommandIndex(args: readonly string[]): number {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1
      continue
    }
    if (arg.startsWith('-')) {
      continue
    }
    return index
  }
  return -1
}

export function isWslDirectGitReadCommand(args: readonly string[]): boolean {
  const subcommandIndex = findGitSubcommandIndex(args)
  if (subcommandIndex === -1) {
    return false
  }
  const subcommand = args[subcommandIndex]
  if (ALWAYS_READ_SUBCOMMANDS.has(subcommand)) {
    return true
  }
  const rest = args.slice(subcommandIndex + 1)

  if (subcommand === 'symbolic-ref') {
    if (rest.some((arg) => arg === '-d' || arg === '--delete' || arg === '-m')) {
      return false
    }
    // Reading takes one ref; a second positional is the value being written.
    return rest.filter((arg) => arg !== '--' && !arg.startsWith('-')).length <= 1
  }

  if (subcommand === 'branch' && hasBranchMutationFlag(rest)) {
    return false
  }

  const readActions = READ_ACTION_SUBCOMMANDS[subcommand]
  if (readActions) {
    const action = rest.find((arg) => !arg.startsWith('-'))
    if (!action) {
      return BARE_FORM_IS_READ.has(subcommand)
    }
    // remote show queries the transport without -n, requiring profile SSH/credential setup.
    if (subcommand === 'remote' && action === 'show') {
      return rest.includes('-n')
    }
    return readActions.has(action)
  }

  const readFlags = READ_FLAG_SUBCOMMANDS[subcommand]
  return Boolean(readFlags && rest.some((arg) => readFlags.has(arg.split('=')[0])))
}

export type GitCommandClass = 'network' | 'read' | 'other'

const NETWORK_SUBCOMMANDS = new Set(['fetch', 'pull', 'push', 'clone', 'ls-remote'])

function positionalAction(args: readonly string[], subcommandIndex: number): string | undefined {
  return args.slice(subcommandIndex + 1).find((arg) => !arg.startsWith('-'))
}

/** Classify only commands whose dominant phase is remote transfer as network work. */
export function classifyGitCommand(args: readonly string[]): GitCommandClass {
  const subcommandIndex = findGitSubcommandIndex(args)
  if (subcommandIndex === -1) {
    return 'other'
  }
  const subcommand = args[subcommandIndex]
  if (NETWORK_SUBCOMMANDS.has(subcommand)) {
    return 'network'
  }
  const action = positionalAction(args, subcommandIndex)
  if (
    (subcommand === 'submodule' && action === 'update') ||
    (subcommand === 'remote' && action === 'update')
  ) {
    return 'network'
  }
  return isWslDirectGitReadCommand(args) ? 'read' : 'other'
}

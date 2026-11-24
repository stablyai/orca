// Whether a tool call may have changed something outside the chat: a write, edit, send, spawn or a
// shell command not known to only read. Unknown tools and commands count as acting, so a person
// is told to check rather than left to assume nothing happened.
import { isCommandToolName } from '../../native-chat/tools/native-chat-tool-activity'

/** Tools that only read or look things up, by lowercased name across providers. */
const READ_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'grep',
  'glob',
  'ls',
  'list',
  'search',
  'websearch',
  'web_search',
  'webfetch',
  'web_fetch',
  'todowrite',
  'toolsearch',
  'notebookread',
  'bashoutput',
  'listmcpresourcestool',
  'readmcpresourcetool'
])

/** Programs that only read, each with the arguments that would make it write or run something. */
const READ_PROGRAMS: Record<string, (args: readonly string[]) => boolean> = {
  cat: () => true,
  head: () => true,
  tail: () => true,
  ls: () => true,
  pwd: () => true,
  echo: () => true,
  printf: () => true,
  wc: () => true,
  grep: () => true,
  egrep: () => true,
  rg: (args) => !args.some((word) => word.startsWith('--pre')),
  find: (args) => !args.some((word) => /^-(exec|execdir|ok|okdir|delete|fprint|fls)/.test(word)),
  tree: () => true,
  file: () => true,
  stat: () => true,
  du: () => true,
  df: () => true,
  which: () => true,
  date: () => true,
  whoami: () => true,
  sort: (args) => !args.some((word) => /^(-o|--output)/.test(word)),
  uniq: (args) => args.length <= 1,
  cut: () => true,
  tr: () => true,
  jq: () => true,
  sed: (args) => !args.some((word) => /^(-i|--in-place|-[^-]*i)/.test(word)),
  diff: () => true,
  cmp: () => true,
  basename: () => true,
  dirname: () => true,
  realpath: () => true,
  nl: () => true,
  true: () => true,
  cd: () => true,
  git: (args) => gitReads(args),
  gh: (args) => ghReads(args),
  orca: (args) => orcaReads(args)
}

const GIT_READS = new Set([
  'log',
  'show',
  'diff',
  'status',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'blame',
  'grep',
  'describe',
  'shortlog',
  'cat-file',
  'merge-base',
  'rev-list'
])

function gitReads(args: readonly string[]): boolean {
  const [sub, ...rest] = args
  if (args.some((word) => word.startsWith('-c') || /^(--output|--exec|--ext-diff)/.test(word))) {
    return false
  }
  if (sub === 'branch' || sub === 'remote') {
    return rest.every((word) => /^(-a|-r|-v|-vv|--all|--remotes|--list|--verbose)$/.test(word))
  }
  return sub !== undefined && GIT_READS.has(sub)
}

const GH_READS: ReadonlySet<string> = new Set(['view', 'list', 'checks', 'diff', 'status'])

function ghReads(args: readonly string[]): boolean {
  const [group, sub] = args
  if (args.some((word) => word === '--web' || word.startsWith('--web='))) {
    return false
  }
  if (group === 'api') {
    return !args.some((word) => /^(-X|--method|-f|-F|--field|--raw-field|--input)/.test(word))
  }
  return group === 'search' || (sub !== undefined && GH_READS.has(sub))
}

/** Orca's own commands that only read, by their leading words. */
const ORCA_READS: readonly (readonly string[])[] = [
  ['slack', 'find'],
  ['slack', 'read'],
  ['slack', 'check'],
  ['bot', 'connectors'],
  ['bot', 'list'],
  ['bot', 'chats'],
  ['bot', 'item', 'list'],
  ['bot', 'item', 'show'],
  ['bot', 'work', 'list'],
  ['linear', 'issue'],
  ['linear', 'search'],
  ['linear', 'list-issues'],
  ['automations', 'list'],
  ['automations', 'show'],
  ['repo', 'list'],
  ['worktree', 'ps'],
  ['worktree', 'list'],
  ['orchestration', 'check'],
  ['orchestration', 'inbox'],
  ['orchestration', 'task-list'],
  ['orchestration', 'worker-list'],
  ['orchestration', 'worker-show'],
  ['orchestration', 'worker-read'],
  ['orchestration', 'run-show'],
  ['orchestration', 'run-list']
]

function orcaReads(args: readonly string[]): boolean {
  return (
    !args.some((word) => /^--(join|download|out)/.test(word)) &&
    ORCA_READS.some((path) => path.every((word, index) => args[index] === word))
  )
}

/** `bash -lc '<command>'` as Codex wraps it: the inner command is what runs. */
function unwrapShell(command: string): string {
  const wrapped = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+'((?:[^']|'\\'')*)'$/.exec(command.trim())
  return wrapped ? wrapped[1]!.replace(/'\\''/g, "'") : command.trim()
}

/** Whether every command in a shell line only reads. Anything this can't read plainly acts. */
export function shellCommandOnlyReads(command: string): boolean {
  const line = unwrapShell(command)
    .replaceAll('"${ORCA_CLI_COMMAND:-orca}"', 'orca')
    .replace(/\s2>&1/g, ' ')
    .replace(/\s2?>\s*\/dev\/null/g, ' ')
  // Redirection, substitution, background jobs and here-docs can write or run anything.
  if (/[>`]|\$\(|<<|(?<!&)&(?!&)/.test(line)) {
    return false
  }
  const commands = line.split(/&&|\|\||[;|\n]/)
  return commands.every((part) => {
    const words = part.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      return true
    }
    const [program, ...args] = words.map((word) => word.replace(/^['"]|['"]$/g, ''))
    const reads = program !== undefined && Object.hasOwn(READ_PROGRAMS, program)
    return reads && READ_PROGRAMS[program!]!(args)
  })
}

/** Whether a tool call may have changed something: false only for a call known to only read. */
export function toolCallHasSideEffects(name: string, input: unknown): boolean {
  const command =
    typeof input === 'object' && input !== null && 'command' in input ? input.command : undefined
  if (
    typeof command === 'string' &&
    (isCommandToolName(name) || READ_TOOLS.has(name.toLowerCase()))
  ) {
    return !shellCommandOnlyReads(command)
  }
  return !READ_TOOLS.has(name.toLowerCase())
}

import { parseGitHubIssueOrPRLink, type RepoSlug } from '../../github/links'
import { parseGitLabIssueOrMRLink, type ProjectSlug } from '../../new-workspace/gitlab-links'
import type { NativeChatMessage } from '../native-chat-types'
import { nativeChatFullCommand } from './native-chat-tool-input-text'
import { pairToolBlocks } from './native-chat-tool-pairs'

export type NativeChatOpenedPullRequest =
  | { provider: 'github'; url: string; slug: RepoSlug; number: number }
  | { provider: 'gitlab'; url: string; slug: ProjectSlug; number: number }

type Provider = NativeChatOpenedPullRequest['provider']

const CREATE_COMMANDS: readonly { provider: Provider; command: RegExp }[] = [
  { provider: 'github', command: /\bgh\s+pr\s+create\b/u },
  { provider: 'gitlab', command: /\bglab\s+mr\s+create\b/u }
]

// Where a shell starts a command, past `NAME=value` assignments and wrappers like `timeout 60`.
// A create command anywhere else, as in `echo "gh pr create"`, is text, not a command that runs.
const COMMAND_START =
  '(?:^|[;&|({`\\n]|\\b(?:do|then|else)\\s)\\s*(?:(?:\\w+=\\S*|env|time|nohup|timeout\\s+\\S+)\\s+)*'
const CREATE_RUNS = CREATE_COMMANDS.map(({ provider, command }) => ({
  provider,
  command,
  // The subcommand must end its shell word: `gh pr create#x` runs another one.
  run: new RegExp(`${COMMAND_START}${command.source}(?=$|[\\s;&|)])`, 'gu')
}))
// Heredoc bodies, quoted strings and comments are text a command carries, not commands it runs.
const HEREDOC_BODY =
  /<<-?[ \t]*(['"]?)(\w+)\1[^\n]*\n(?:(?:[\s\S]*?\n)?[ \t]*\2[ \t]*(?=\n|$)|[\s\S]*$)/gu
const QUOTED_OR_COMMENT = /'[^']*'|"(?:\\[\s\S]|[^"\\])*"|(?<=^|[\s;&|(])#[^\n]*/gmu
const COMMAND_SEPARATOR = /&&|\|\||[;|\n]/u
// Commands that print other change requests' URLs, so output beside them proves nothing.
const LISTS_CHANGE_REQUESTS =
  /\b(?:gh\s+(?:pr\s+(?:list|status)|search\s+prs|api)|glab\s+(?:mr\s+list|api))\b/u
const URL_LINE = /^[ \t]*(https?:\/\/\S+)[ \t]*$/gmu
const SHELL_PROGRAM = /^(?:.*[\\/])?(?:ba|z|k|da|fi)?sh(?:\.exe)?$/u
const SHELL_SCRIPT_FLAG = /^-[a-zA-Z]*c$/u

function argvCommand(input: unknown): readonly string[] | null {
  let value = input
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const argv =
    'command' in value && Array.isArray(value.command)
      ? value.command
      : 'cmd' in value
        ? value.cmd
        : null
  return Array.isArray(argv) && argv.every((part) => typeof part === 'string') ? argv : null
}

/** The script a tool call ran. An argv `[sh, -lc, script]` keeps its script whole; joining it would
 *  leave the create command after the wrapper instead of at a command start. */
function commandScript(input: unknown): string | null {
  const argv = argvCommand(input)
  if (argv?.length === 3 && SHELL_PROGRAM.test(argv[0]) && SHELL_SCRIPT_FLAG.test(argv[1])) {
    return argv[2]
  }
  return nativeChatFullCommand(input)
}

function createCount(code: string): number {
  return CREATE_RUNS.reduce((count, { run }) => count + [...code.matchAll(run)].length, 0)
}

/** The commands a script runs, without the text it carries. */
function shellCode(script: string): string {
  return script.replace(HEREDOC_BODY, '<<').replace(QUOTED_OR_COMMENT, "''")
}

/** A script split at command separators that sit outside quotes. */
function shellSegments(script: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: string | null = null
  for (let index = 0; index < script.length; index++) {
    const char = script[index]
    if (quote !== null) {
      current += char
      if (char === '\\' && quote === '"') {
        current += script[++index] ?? ''
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
    }
    if (char === '\\') {
      current += char + (script[++index] ?? '')
      continue
    }
    const pair = script.slice(index, index + 2)
    if (pair === '&&' || pair === '||' || char === ';' || char === '|' || char === '\n') {
      segments.push(current)
      current = ''
      if (pair === '&&' || pair === '||') {
        index++
      }
      continue
    }
    current += char
  }
  segments.push(current)
  return segments
}

/** One pull request however its URL was printed (`/pull/12` and `/pull/12/files`). */
export function nativeChatOpenedPullRequestKey(pullRequest: NativeChatOpenedPullRequest): string {
  const repo =
    pullRequest.provider === 'github'
      ? `${pullRequest.slug.host ?? 'github.com'}/${pullRequest.slug.owner}/${pullRequest.slug.repo}`
      : `${pullRequest.slug.host}/${pullRequest.slug.path}`
  return `${pullRequest.provider}:${repo.toLowerCase()}#${pullRequest.number}`
}

function parseChangeRequestUrl(url: string): NativeChatOpenedPullRequest | null {
  const github = parseGitHubIssueOrPRLink(url)
  if (github?.type === 'pr') {
    return { provider: 'github', url, slug: github.slug, number: github.number }
  }
  const gitlab = parseGitLabIssueOrMRLink(url)
  return gitlab?.type === 'mr'
    ? { provider: 'gitlab', url, slug: gitlab.slug, number: gitlab.number }
    : null
}

/**
 * The pull requests a shell command opened: URLs on lines of their own in the output of a command
 * that runs a host's create command. One the command also names, as `gh pr view 12` does, existed
 * before it ran. More URLs than create commands means something else printed some, such as
 * `gh pr list`, so none are taken.
 */
export function pullRequestsOpenedBy(
  script: string,
  output: string
): NativeChatOpenedPullRequest[] {
  if (!isPullRequestCreateScript(script)) {
    return []
  }
  const code = shellCode(script)
  const creates = createCount(code)
  if (creates === 0) {
    return []
  }
  const otherCommands = code
    .split(COMMAND_SEPARATOR)
    .filter((part) => createCount(part) === 0)
    .join('\n')
  if (LISTS_CHANGE_REQUESTS.test(otherCommands)) {
    return []
  }
  const otherScript = shellSegments(script)
    .filter((segment) => createCount(shellCode(segment)) === 0)
    .join('\n')
  const creators = new Set(
    CREATE_RUNS.filter(({ run }) => code.match(run) !== null).map(({ provider }) => provider)
  )
  const opened = new Map<string, NativeChatOpenedPullRequest>()
  for (const [, url = ''] of output.matchAll(URL_LINE)) {
    const parsed = parseChangeRequestUrl(url)
    // Only the host whose create command ran can have printed a new change request.
    if (parsed === null || !creators.has(parsed.provider)) {
      continue
    }
    const named = new RegExp(`(?:^|(?<=[\\s#/=("']))${parsed.number}(?=$|[\\s);&|/"'])`, 'u')
    // Quoted text in the other commands counts, as in `printf '.../pull/12'`.
    if (named.test(otherScript)) {
      continue
    }
    opened.set(nativeChatOpenedPullRequestKey(parsed), parsed)
  }
  return opened.size > creates ? [] : [...opened.values()]
}

// Commands after which a pull request's title, counts or state may have changed.
const CHANGES_PULL_REQUEST =
  /\b(?:git\s+push|gh\s+pr\s+(?:merge|edit|close|reopen|ready)|glab\s+mr\s+(?:merge|update|close|reopen))\b/u

export type NativeChatTurnOpenedPullRequests = {
  byTurn: ReadonlyMap<string, readonly NativeChatOpenedPullRequest[]>
  /** Create commands' results cut to a head; their full text decides what they opened. */
  clippedCreateOutputs: readonly string[]
  /** The newest finished command that may have changed a pull request, so cards reread it. */
  latestChangeKey: string | undefined
}

/** Pull requests each turn's own commands opened, in the order they were opened. A partly loaded
 *  turn shows none until its create call is loaded. */
export function nativeChatTurnOpenedPullRequests(
  messages: readonly NativeChatMessage[],
  turnKeys: readonly (string | undefined)[],
  options: {
    partialTurnKey?: string
    /** Full text of clipped results, by `fullOutputItemId`. */
    fullOutputs?: ReadonlyMap<string, string>
  } = {}
): NativeChatTurnOpenedPullRequests {
  const byTurn = new Map<string, NativeChatOpenedPullRequest[]>()
  const clippedCreateOutputs: string[] = []
  let latestChangeKey: string | undefined
  for (const [index, message] of messages.entries()) {
    const turnKey = turnKeys[index]
    for (const [pairIndex, { call, result }] of pairToolBlocks(message.blocks).entries()) {
      // A failed call still opened its pull request when it printed one, as in
      // `gh pr create && gh pr checks --watch` with a failing check.
      if (!call || !result || call.state === 'running') {
        continue
      }
      const script = commandScript(call.input)
      if (!script) {
        continue
      }
      if (CHANGES_PULL_REQUEST.test(shellCode(script)) || isPullRequestCreateScript(script)) {
        latestChangeKey = `${message.id}:${pairIndex}`
      }
      if (!turnKey || turnKey === options.partialTurnKey) {
        continue
      }
      const fullOutput = result.fullOutputItemId
        ? options.fullOutputs?.get(result.fullOutputItemId)
        : undefined
      const opened = pullRequestsOpenedBy(script, commandOutputText(fullOutput ?? result.output))
      // Evidence past the clipped head can add a pull request or disqualify one, so read it whole.
      if (
        result.fullOutputItemId &&
        fullOutput === undefined &&
        isPullRequestCreateScript(script)
      ) {
        clippedCreateOutputs.push(result.fullOutputItemId)
      }
      for (const pullRequest of opened) {
        const list = byTurn.get(turnKey) ?? []
        const key = nativeChatOpenedPullRequestKey(pullRequest)
        if (!list.some((known) => nativeChatOpenedPullRequestKey(known) === key)) {
          list.push(pullRequest)
        }
        byTurn.set(turnKey, list)
      }
    }
  }
  return { byTurn, clippedCreateOutputs, latestChangeKey }
}

/** Older Codex transcripts keep a command's output as JSON (`{"output": "...", "metadata": ...}`). */
function commandOutputText(output: string): string {
  if (!output.startsWith('{')) {
    return output
  }
  try {
    const parsed: unknown = JSON.parse(output)
    return parsed !== null &&
      typeof parsed === 'object' &&
      'output' in parsed &&
      typeof parsed.output === 'string'
      ? parsed.output
      : output
  } catch {
    return output
  }
}

function isPullRequestCreateScript(script: string): boolean {
  return CREATE_COMMANDS.some(({ command }) => command.test(script))
}

import { parseGitHubIssueOrPRLink, type RepoSlug } from '../../github/links'
import { parseGitLabIssueOrMRLink, type ProjectSlug } from '../../new-workspace/gitlab-links'
import type { NativeChatMessage } from '../native-chat-types'
import { nativeChatToolCallScript } from './native-chat-tool-call-script'
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
export const COMMAND_START =
  '(?:^|[;&|({`\\n]|\\b(?:do|then|else)\\s)\\s*(?:(?:\\w+=\\S*|env|time|nohup|timeout\\s+\\S+)\\s+)*'
const CREATE_RUNS = CREATE_COMMANDS.map(({ provider, command }) => ({
  provider,
  command,
  // The subcommand must end its shell word: `gh pr create#x` runs another one.
  run: new RegExp(`${COMMAND_START}${command.source}(?=$|[\\s;&|)])`, 'gu')
}))
// Heredoc bodies, quoted strings, comments and escaped characters (`\;`) are text a command carries,
// not commands it runs. Unlike the common pattern, escapes count too: `printf x \; gh pr create` runs
// only printf.
const HEREDOC_BODY =
  /<<-?[ \t]*(['"]?)(\w+)\1[^\n]*\n(?:(?:[\s\S]*?\n)?[ \t]*\2[ \t]*(?=\n|$)|[\s\S]*$)/gu
const QUOTED_OR_COMMENT = /'[^']*'|"(?:\\[\s\S]|[^"\\])*"|(?<=^|[\s;&|(])#[^\n]*|\\\n|\\[\s\S]/gmu
const COMMAND_SEPARATOR = /&&|\|\||[;|\n]/u
// Commands that print other change requests' URLs, so output beside them proves nothing.
const LISTS_CHANGE_REQUESTS =
  /\b(?:gh\s+(?:pr\s+(?:list|status)|search\s+prs|api)|glab\s+(?:mr\s+list|api))\b/u
const URL_LINE = /^[ \t]*(https?:\/\/\S+)[ \t]*$/gmu
function createCount(code: string): number {
  return CREATE_RUNS.reduce((count, { run }) => count + [...code.matchAll(run)].length, 0)
}

/** The commands a script runs, without the text it carries. */
export function shellCode(script: string): string {
  return script.replace(HEREDOC_BODY, '<<').replace(QUOTED_OR_COMMENT, (text) =>
    // A line continuation (backslash-LF) joins lines, as the shell removes it; any other text,
    // including a backslash before CR, becomes one word.
    text === '\\\n' ? '' : "''"
  )
}

// Quoted text, escapes and comments match first and are skipped; then an unquoted heredoc
// operator (`<<EOF`, `<<'EOF'`, `<<"EOF"`, `<<-EOF`, never a `<<<` here-string), or a line end.
const TEXT_HEREDOC_OR_LINE_END = new RegExp(
  `(${QUOTED_OR_COMMENT.source})|(?<!<)<<(-?)[ \\t]*(['"]?)(\\w+)\\3|\\n`,
  'gmu'
)

/** Where the body that starts at `start` ends: after its delimiter line, or at the script's end. */
function heredocBodyEnd(script: string, start: number, delimiter: string, tabs: boolean): number {
  let lineStart = start
  while (lineStart < script.length) {
    const newline = script.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? script.length : newline
    const line = script.slice(lineStart, lineEnd)
    if ((tabs ? line.replace(/^\t+/u, '') : line) === delimiter) {
      return newline === -1 ? script.length : newline + 1
    }
    lineStart = lineEnd + 1
  }
  // Unterminated: everything after the declaration is the body, never commands.
  return script.length
}

/**
 * A script without its heredoc bodies and delimiter lines. Each declaration line keeps its own
 * commands, separators and spelling (`cat <<'EOF' > notes.md; git push 2>&1`), and the newline that
 * ends it, so the line after the delimiter still starts a new command.
 */
export function withoutHeredocBodyLines(script: string): string {
  const scan = new RegExp(TEXT_HEREDOC_OR_LINE_END)
  const pending: { delimiter: string; tabs: boolean }[] = []
  let kept = ''
  let from = 0
  for (let match = scan.exec(script); match; match = scan.exec(script)) {
    if (match[1] !== undefined) {
      continue
    }
    if (match[4] !== undefined) {
      pending.push({ delimiter: match[4], tabs: match[2] === '-' })
      continue
    }
    if (pending.length === 0) {
      continue
    }
    // Bodies follow the declaration line in the order their operators appeared.
    let end = match.index + 1
    for (const { delimiter, tabs } of pending.splice(0)) {
      end = heredocBodyEnd(script, end, delimiter, tabs)
    }
    kept += script.slice(from, match.index + 1)
    from = end
    scan.lastIndex = end
  }
  return kept + script.slice(from)
}

// Redirections outside quotes: an fd copy or close (`2>&1`, `>&2`, `<&-`), or a file target
// (`>out`, `2>>log`, `&>log`, `>|f`, `< in`). Quoted text and escapes match first and stay.
const FD = '(?:(?<=^|\\s)\\d+)?'
const TARGET = `(?:[^\\s;&|<>()'"\\\\]|\\\\[\\s\\S]|'[^']*'|"(?:\\\\[\\s\\S]|[^"\\\\])*")+`
const TEXT_OR_REDIRECTION = new RegExp(
  `(${QUOTED_OR_COMMENT.source})|${FD}[<>]&(?:\\d+|-)(?=$|\\s)|(?:${FD}(?:>>|>\\||<>|>|<)|&>>|&>)\\s*${TARGET}`,
  'gmu'
)

/** A command with its unquoted redirections removed, so `git push 2>&1` reads as `git push`. */
export function withoutShellRedirections(command: string): string {
  return command.replace(TEXT_OR_REDIRECTION, (match, text: string | undefined) =>
    text === undefined ? ' ' : match
  )
}

/** A script split at command separators that sit outside quotes. */
export function shellSegments(script: string): string[] {
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
    // `>|` is one redirection token, a clobbering write, not `>` before a pipe.
    if (pair === '>|') {
      current += pair
      index++
      continue
    }
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

/** What one message's own commands did; a message's blocks never change once written. */
type MessageEvidence = {
  opened: readonly NativeChatOpenedPullRequest[]
  clipped: readonly string[]
  changeKey: string | undefined
}

/** Reused across transcript updates so a streaming reply rescans only rows that changed. */
export type NativeChatOpenedPullRequestsCache = WeakMap<NativeChatMessage, MessageEvidence>

function messageEvidence(
  message: NativeChatMessage,
  fullOutputs: ReadonlyMap<string, string | null> | undefined
): MessageEvidence {
  const opened: NativeChatOpenedPullRequest[] = []
  const clipped: string[] = []
  let changeKey: string | undefined
  for (const [pairIndex, { call, result }] of pairToolBlocks(message.blocks).entries()) {
    // A failed call still opened its pull request when it printed one, as in
    // `gh pr create && gh pr checks --watch` with a failing check.
    if (!call || !result || call.state === 'running') {
      continue
    }
    const script = nativeChatToolCallScript(call.name, call.input)
    if (!script) {
      continue
    }
    const creates = isPullRequestCreateScript(script)
    if (creates || CHANGES_PULL_REQUEST.test(shellCode(script))) {
      changeKey = `${message.id}:${pairIndex}`
    }
    if (!creates) {
      continue
    }
    let output = result.output
    if (result.fullOutputItemId) {
      const whole = fullOutputs?.get(result.fullOutputItemId)
      if (whole === undefined) {
        // Evidence past the clipped head can add a pull request or disqualify one; wait for it.
        clipped.push(result.fullOutputItemId)
        continue
      }
      // Null: the host can't give it whole, so the head is all the evidence there is.
      output = whole ?? result.output
    }
    opened.push(...pullRequestsOpenedBy(script, commandOutputText(output)))
  }
  return { opened, clipped, changeKey }
}

/** Pull requests each turn's own commands opened, in the order they were opened. A partly loaded
 *  turn shows none until its create call is loaded. */
export function nativeChatTurnOpenedPullRequests(
  messages: readonly NativeChatMessage[],
  turnKeys: readonly (string | undefined)[],
  options: {
    partialTurnKey?: string
    /** Clipped results read whole, by `fullOutputItemId`; null when the host can't. */
    fullOutputs?: ReadonlyMap<string, string | null>
    /** Valid for one `fullOutputs`; pass a new one when it changes. */
    cache?: NativeChatOpenedPullRequestsCache
  } = {}
): NativeChatTurnOpenedPullRequests {
  const byTurn = new Map<string, NativeChatOpenedPullRequest[]>()
  const clippedCreateOutputs: string[] = []
  let latestChangeKey: string | undefined
  for (const [index, message] of messages.entries()) {
    let evidence = options.cache?.get(message)
    if (!evidence) {
      evidence = messageEvidence(message, options.fullOutputs)
      options.cache?.set(message, evidence)
    }
    latestChangeKey = evidence.changeKey ?? latestChangeKey
    const turnKey = turnKeys[index]
    if (!turnKey || turnKey === options.partialTurnKey) {
      continue
    }
    clippedCreateOutputs.push(...evidence.clipped)
    for (const pullRequest of evidence.opened) {
      const list = byTurn.get(turnKey) ?? []
      const key = nativeChatOpenedPullRequestKey(pullRequest)
      if (!list.some((known) => nativeChatOpenedPullRequestKey(known) === key)) {
        list.push(pullRequest)
      }
      byTurn.set(turnKey, list)
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

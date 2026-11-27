// What a new bot's first turn found, as its first screen lists it: one row per area it read with
// tools it already has, built from its own tool calls and their output, never from its words.
import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import type { NativeChatMessage, NativeChatToolResultBlock } from '../native-chat/native-chat-types'
import { pairToolBlocks } from '../native-chat/tools/native-chat-tool-pairs'
import { nativeChatFullCommand } from '../native-chat/tools/native-chat-tool-input-text'

export const FIRST_LOOK_AREAS = ['projects', 'github', 'linear', 'workspaces', 'tools'] as const
export type FirstLookArea = (typeof FIRST_LOOK_AREAS)[number]

/** `stopped`: the turn ended while the area's read was still running. A read that failed has no row. */
export type FirstLookRow = {
  area: FirstLookArea
  state: 'running' | 'done' | 'stopped'
  /** What the area's output counted (for workspaces, those with an agent open); absent when no output could be read. */
  count?: number
  /** The list stopped at its limit, so there are more than `count`. */
  more?: true
  /** Project or MCP server names, when the output named them. */
  names?: string[]
}

const MCP_CONFIG_FILE = /(^|[\\/])(\.claude\.json|\.mcp\.json|config\.toml)$/

function areaOfCommand(command: string): FirstLookArea | null {
  // Each segment of a chained command, without a leading `cd …` or env assignments.
  for (const segment of command.split(/&&|\|\||;/)) {
    const words = segment.trim().split(/\s+/)
    const at = words.findIndex((word) => !/^\w+=/.test(word))
    const [first, second, third] = words.slice(at)
    if (first === 'gh') {
      return 'github'
    }
    if ((first === 'claude' || first === 'codex') && second === 'mcp') {
      return 'tools'
    }
    if (first && /orca/i.test(first)) {
      if (second === 'repo' && third === 'list') {
        return 'projects'
      }
      if (second === 'linear') {
        return 'linear'
      }
      if (second === 'worktree' && third === 'ps') {
        return 'workspaces'
      }
    }
  }
  return null
}

function areaOf(call: { name: string; input: unknown }): FirstLookArea | null {
  const command = nativeChatFullCommand(call.input)
  if (command) {
    return areaOfCommand(command)
  }
  const path =
    call.input && typeof call.input === 'object' && 'file_path' in call.input
      ? call.input.file_path
      : null
  return typeof path === 'string' && MCP_CONFIG_FILE.test(path) ? 'tools' : null
}

function parsed(output: string): unknown {
  try {
    return JSON.parse(output)
  } catch {
    return undefined
  }
}

const RepoList = lazyZodSchema(() =>
  z.object({ repos: z.array(z.object({ displayName: z.string() })) })
)
// `orca … --json` prints an RPC envelope, its payload under `result`.
const Repos = lazyZodSchema(() =>
  z.union([z.object({ result: RepoList }).transform((value) => value.result), RepoList])
)
const IssueList = lazyZodSchema(() =>
  z.object({
    issues: z.array(z.unknown()),
    truncated: z.boolean().optional()
  })
)
const Issues = lazyZodSchema(() =>
  z.union([z.object({ result: IssueList }).transform((value) => value.result), IssueList])
)
const PsList = lazyZodSchema(() =>
  z.object({
    worktrees: z.array(
      z.object({
        botHome: z.literal(true).optional(),
        agents: z.array(z.object({ address: z.string().optional() }))
      })
    )
  })
)
const Workspaces = lazyZodSchema(() =>
  z.union([z.object({ result: PsList }).transform((value) => value.result), PsList])
)
const ServerList = lazyZodSchema(() => z.array(z.object({ name: z.string() })))
const McpServers = lazyZodSchema(() =>
  z.union([ServerList, z.object({ servers: ServerList }).transform((value) => value.servers)])
)
const PR_LIST_COMMAND = /\bgh\s+(search\s+prs|pr\s+list)\b/
// What `structured-agent-session-projection` appends to a head it cut.
const CUT_OUTPUT = /\n… \(\d+ bytes\)$/
const LIST_TRUNCATED = /^truncated: showing \d+/

function lines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** `orca repo list` prints `id  name  path` per repo. */
function repoNamesFromText(output: string): string[] | undefined {
  if (output.startsWith('No repos found.')) {
    return []
  }
  const names: string[] = []
  for (const line of lines(output)) {
    const name = line.split(/\s{2,}/)[1]
    if (name === undefined) {
      return undefined
    }
    names.push(name)
  }
  return names
}

/** `orca linear list-issues` prints one issue per line, then `truncated: showing N` at its limit. */
function issueCountFromText(output: string): Partial<FirstLookRow> {
  if (output.startsWith('No Linear issues found.')) {
    return { count: 0 }
  }
  const rows = lines(output)
  const count = rows.filter((line) => !LIST_TRUNCATED.test(line)).length
  return rows.length > count ? { count, more: true } : { count }
}

/** `orca worktree ps` prints a block per workspace; an open agent's line names its `--terminal`. */
function agentWorkspacesFromText(output: string): number | undefined {
  if (output.startsWith('No worktrees found.')) {
    return 0
  }
  const blocks = output.split(/\n\s*\n/).filter((block) => /^--worktree id:/m.test(block))
  if (blocks.length === 0) {
    return undefined
  }
  return blocks.filter(
    (block) => !/ · home of bot /.test(block) && /^agent .*\(--terminal /m.test(block)
  ).length
}

/** `claude mcp list` prints `name: command - status` per server. */
function mcpNamesFromText(output: string): string[] | undefined {
  const names = output
    .split('\n')
    .map((line) => /^([\w.@-]+):\s/.exec(line.trim())?.[1])
    .filter((name): name is string => name !== undefined)
  return names.length > 0 || /no mcp servers/i.test(output) ? names : undefined
}

function findings(
  area: FirstLookArea,
  command: string | null,
  result: NativeChatToolResultBlock
): Partial<FirstLookRow> {
  // The display copy keeps only a head of a long output, so it can't be counted.
  if (result.fullOutputItemId || CUT_OUTPUT.test(result.output)) {
    return {}
  }
  const output = result.output.trim()
  const value = parsed(output)
  switch (area) {
    case 'projects': {
      const repos = Repos.safeParse(value)
      const names = repos.success
        ? repos.data.repos.map((repo) => repo.displayName)
        : repoNamesFromText(output)
      return names ? { count: names.length, names } : {}
    }
    case 'linear': {
      if (value === undefined) {
        return issueCountFromText(output)
      }
      const issues = Issues.safeParse(value)
      if (!issues.success) {
        return {}
      }
      const count = issues.data.issues.length
      return issues.data.truncated ? { count, more: true } : { count }
    }
    case 'github':
      if (Array.isArray(value)) {
        return { count: value.length }
      }
      return value === undefined && command && PR_LIST_COMMAND.test(command)
        ? { count: lines(output).length }
        : {}
    case 'workspaces': {
      const listed = Workspaces.safeParse(value)
      const count = listed.success
        ? listed.data.worktrees.filter(
            (row) => !row.botHome && row.agents.some((agent) => agent.address)
          ).length
        : agentWorkspacesFromText(output)
      return count === undefined ? {} : { count }
    }
    case 'tools': {
      const listed = McpServers.safeParse(value)
      const servers = listed.success
        ? listed.data.map((server) => server.name)
        : mcpNamesFromText(output)
      return servers ? { count: servers.length, names: servers } : {}
    }
  }
}

/** The rows for a first turn's messages, in the order each area was first read. */
export function firstLookRows(
  messages: readonly NativeChatMessage[],
  turnEnded: boolean
): FirstLookRow[] {
  const rows = new Map<FirstLookArea, FirstLookRow>()
  for (const { call, result } of pairToolBlocks(messages.flatMap((message) => message.blocks))) {
    const area = call ? areaOf(call) : null
    if (!call || !area) {
      continue
    }
    const failed = call.state === 'failed' || result?.isError === true
    const running = !failed && !result && call.state !== 'completed'
    const current = rows.get(area)
    if (running) {
      if (current?.state !== 'done') {
        rows.set(area, { area, state: turnEnded ? 'stopped' : 'running' })
      }
    } else if (!failed) {
      const found = result ? findings(area, nativeChatFullCommand(call.input), result) : {}
      // A later read that counted nothing readable keeps what an earlier one counted.
      if (found.count !== undefined || current?.state !== 'done' || current.count === undefined) {
        rows.set(area, { area, state: 'done', ...found })
      }
    }
  }
  return [...rows.values()]
}

// `claude mcp add …`, `claude mcp add-json …` and `codex mcp add …` lines, read the way each CLI
// reads its arguments, into the entry that command would save.
import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { agentMcpConfigEntry, type AgentMcpConfigEntry } from './agent-mcp-config-entry'

export class McpAddCommandError extends Error {
  constructor(readonly reason: 'unsupported' | 'invalid') {
    super(reason)
  }
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const HEADER_LINE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+:/
const URL_LIKE = /^https?:\/\//i

/** The `mcp add` words a pasted line starts with, or null when it is no such line. */
export function mcpAddCommandKind(
  tokens: readonly string[]
): 'claude' | 'claude-json' | 'codex' | null {
  const [cli, mcp, verb] = tokens
  if (mcp !== 'mcp' || (cli !== 'claude' && cli !== 'codex')) {
    return null
  }
  if (verb === 'add') {
    return cli
  }
  return cli === 'claude' && verb === 'add-json' ? 'claude-json' : null
}

function assignment(token: string | undefined): [string, string] {
  if (token === undefined || !ENV_ASSIGNMENT.test(token)) {
    throw new McpAddCommandError('invalid')
  }
  const at = token.indexOf('=')
  return [token.slice(0, at), token.slice(at + 1)]
}

function header(token: string | undefined): [string, string] {
  if (token === undefined || !HEADER_LINE.test(token)) {
    throw new McpAddCommandError('invalid')
  }
  const at = token.indexOf(':')
  return [token.slice(0, at), token.slice(at + 1).trim()]
}

function entry(name: string | undefined, raw: Record<string, unknown>): AgentMcpConfigEntry {
  if (name === undefined) {
    throw new McpAddCommandError('invalid')
  }
  const read = agentMcpConfigEntry(name, raw, 'mcp-json')
  if (!read) {
    throw new McpAddCommandError('unsupported')
  }
  return read
}

// Claude's -e and -H take every value up to the next flag, so the command follows `--`.
function parseClaudeAdd(tokens: readonly string[]): AgentMcpConfigEntry {
  const positional: string[] = []
  const env: Record<string, string> = {}
  const headers: Record<string, string> = {}
  let transport: string | undefined
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    if (token === '--') {
      positional.push(...tokens.slice(index + 1))
      break
    }
    // Once a command is named, later words are its own arguments; a URL takes no arguments.
    const remoteTarget =
      transport === undefined ? URL_LIKE.test(positional[1] ?? '') : transport !== 'stdio'
    if ((positional.length >= 2 && !remoteTarget) || !token.startsWith('-')) {
      positional.push(token)
      index += 1
      continue
    }
    const [flag, inline] =
      token.startsWith('--') && token.includes('=')
        ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)]
        : [token, undefined]
    const value = (): string => {
      const next = inline ?? tokens[index + 1]
      if (next === undefined) {
        throw new McpAddCommandError('invalid')
      }
      index += inline === undefined ? 2 : 1
      return next
    }
    const values = (matches: (word: string) => boolean): string[] => {
      const taken = [inline ?? tokens[index + 1]]
      index += inline === undefined ? 2 : 1
      while (index < tokens.length && matches(tokens[index]!)) {
        taken.push(tokens[index]!)
        index += 1
      }
      return taken.filter((word): word is string => word !== undefined)
    }
    switch (flag) {
      case '-t':
      case '--transport':
        transport = value()
        break
      case '-s':
      case '--scope':
      case '--client-id':
      case '--callback-port':
        value()
        break
      case '--client-secret':
        index += 1
        break
      case '-e':
      case '--env':
        for (const word of values((next) => ENV_ASSIGNMENT.test(next))) {
          const [key, item] = assignment(word)
          env[key] = item
        }
        break
      case '-H':
      case '--header':
        for (const word of values((next) => HEADER_LINE.test(next) && !URL_LIKE.test(next))) {
          const [key, item] = header(word)
          headers[key] = item
        }
        break
      default:
        throw new McpAddCommandError('invalid')
    }
  }
  const [name, target, ...args] = positional
  if (target === undefined) {
    throw new McpAddCommandError('invalid')
  }
  const remote = transport === undefined ? URL_LIKE.test(target) : transport !== 'stdio'
  if (remote) {
    if (args.length > 0) {
      throw new McpAddCommandError('invalid')
    }
    return entry(name, {
      type: transport ?? 'http',
      url: target,
      ...(Object.keys(headers).length > 0 ? { headers } : {})
    })
  }
  return entry(name, {
    type: 'stdio',
    command: target,
    args,
    ...(Object.keys(env).length > 0 ? { env } : {})
  })
}

function parseClaudeAddJson(tokens: readonly string[]): AgentMcpConfigEntry {
  const positional: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token === '-s' || token === '--scope') {
      index += 1
    } else if (!token.startsWith('--scope=') && token !== '--client-secret') {
      positional.push(token)
    }
  }
  const [name, json, ...rest] = positional
  const errors: ParseError[] = []
  const raw: unknown = json === undefined ? undefined : parseJsonc(json, errors)
  if (rest.length > 0 || errors.length > 0 || typeof raw !== 'object' || raw === null) {
    throw new McpAddCommandError('invalid')
  }
  return entry(name, Object.fromEntries(Object.entries(raw)))
}

// Codex: `codex mcp add <name> [--env K=V]... (--url <url> | -- <command> [args]...)`.
function parseCodexAdd(tokens: readonly string[]): AgentMcpConfigEntry {
  let name: string | undefined
  let url: string | undefined
  const env: Record<string, string> = {}
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token === '--') {
      const [command, ...args] = tokens.slice(index + 1)
      if (url !== undefined || command === undefined) {
        throw new McpAddCommandError('invalid')
      }
      return entry(name, {
        command,
        args,
        ...(Object.keys(env).length > 0 ? { env } : {})
      })
    }
    const [flag, inline] =
      token.includes('=') && token.startsWith('--')
        ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)]
        : [token, undefined]
    const value = (): string | undefined => inline ?? tokens[++index]
    if (flag === '--env') {
      const [key, item] = assignment(value())
      env[key] = item
    } else if (flag === '--url') {
      url = value()
    } else if (flag === '--bearer-token-env-var') {
      // The token comes from Codex's own environment, which Orca can't carry.
      throw new McpAddCommandError('unsupported')
    } else if (!token.startsWith('-') && name === undefined) {
      name = token
    } else {
      throw new McpAddCommandError('invalid')
    }
  }
  if (url === undefined) {
    throw new McpAddCommandError('invalid')
  }
  return entry(name, { type: 'http', url })
}

/** The server one `mcp add` line saves; `tokens` are the whole line's shell words. */
export function parseMcpAddCommand(tokens: readonly string[]): AgentMcpConfigEntry {
  const kind = mcpAddCommandKind(tokens)
  const rest = tokens.slice(3)
  switch (kind) {
    case 'claude':
      return parseClaudeAdd(rest)
    case 'claude-json':
      return parseClaudeAddJson(rest)
    case 'codex':
      return parseCodexAdd(rest)
    default:
      throw new McpAddCommandError('invalid')
  }
}

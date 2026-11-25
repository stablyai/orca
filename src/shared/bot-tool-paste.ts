import {
  botToolNameFrom,
  BotToolServerSchema,
  botToolInputError,
  type BotToolServer
} from './bot-tools'
import { extractLeadingEnvAssignments } from './shell/launch/command-environment'
import { tokenizeCustomCommandTemplate } from './source-control/ai/generation/commit-message-prompt'
import { englishTranslate, type CopyTranslate } from './i18n/english-translate'
import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { agentMcpConfigEntry, type AgentMcpConfigEntry } from './mcp/agent-mcp-config-entry'
import {
  McpAddCommandError,
  mcpAddCommandKind,
  parseMcpAddCommand
} from './mcp/mcp-add-command-paste'

/** Throws in the reader's words (English for main and the CLI) when the paste is no server. */
export function parseBotToolPaste(
  source: string,
  platform: NodeJS.Platform,
  t: CopyTranslate = englishTranslate
): BotToolServer {
  const text = source.trim()
  const name = botToolNameFrom(text)
  if (/^[{[]/.test(text)) {
    throw new Error(
      t(
        'bots.tools.paste.notConfig',
        'Paste a server URL or start command, or enter the configuration in Edit details.'
      )
    )
  }
  if (/^https?:|^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const result = BotToolServerSchema.safeParse({ name, url: text })
    if (!result.success) {
      throw new Error(
        t('bots.tools.paste.badUrl', 'Use an HTTP or HTTPS URL without embedded credentials.')
      )
    }
    return result.data
  }
  const parsed = tokenizeCustomCommandTemplate(text, platform === 'win32' ? 'literal' : 'escape')
  if (!parsed.ok || parsed.spans.some((span) => span.divergesFromShell) || /[\r\n]/.test(text)) {
    throw new Error(
      t(
        'bots.tools.paste.badCommand',
        'Use a single start command with balanced quotes, or enter the details manually. Shell expressions are not supported.'
      )
    )
  }
  const {
    env,
    rest: [command, ...args]
  } = extractLeadingEnvAssignments(parsed.tokens)
  const input = {
    name: botToolNameFrom([command, ...args].join(' ')),
    command: command ?? '',
    args,
    env: Object.entries(env ?? {}).map(([key, value]) => ({ key, value }))
  }
  const error = botToolInputError(input, platform, t)
  if (error) {
    throw new Error(error)
  }
  return { name: input.name, command: input.command, args, ...(env ? { env } : {}) }
}

function pastedConfigServers(text: string): AgentMcpConfigEntry[] | null {
  const errors: ParseError[] = []
  // A copied `"name": {…}` fragment is the inside of an mcpServers block.
  const raw: unknown = parseJsonc(text.startsWith('"') ? `{${text}}` : text, errors, {
    allowTrailingComma: true
  })
  if (errors.length > 0 || typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null
  }
  const root = Object.fromEntries(Object.entries(raw))
  const block = root.mcpServers ?? root.servers
  if (block !== undefined) {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
      return null
    }
    return Object.entries(block).flatMap(([name, entry]) => {
      const read = agentMcpConfigEntry(name, entry, 'mcp-json')
      return read ? [read] : []
    })
  }
  const single = agentMcpConfigEntry('', root, 'mcp-json')
  if (single) {
    return [single]
  }
  return Object.entries(root).flatMap(([name, entry]) => {
    const read = agentMcpConfigEntry(name, entry, 'mcp-json')
    return read ? [read] : []
  })
}

function pastedLineServer(
  line: string,
  platform: NodeJS.Platform,
  t: CopyTranslate
): BotToolServer {
  const parsed = tokenizeCustomCommandTemplate(line, platform === 'win32' ? 'literal' : 'escape')
  const kind = parsed.ok ? mcpAddCommandKind(parsed.tokens) : null
  if (!parsed.ok || kind === null) {
    return parseBotToolPaste(line, platform, t)
  }
  if (parsed.spans.some((span) => span.divergesFromShell)) {
    throw new Error(
      t(
        'mcpServers.paste.badCommand',
        'Use plain quoted words in the mcp add command. Shell expressions are not supported.'
      )
    )
  }
  try {
    return parseMcpAddCommand(parsed.tokens).server
  } catch (error) {
    if (error instanceof McpAddCommandError && error.reason === 'unsupported') {
      throw new Error(
        t(
          'mcpServers.paste.unsupported',
          'Orca can’t add this server: it uses SSE or reads its token from the environment.'
        )
      )
    }
    throw new Error(
      t('mcpServers.paste.badAddCommand', 'Check the mcp add command: a name and a URL or command.')
    )
  }
}

/**
 * The servers a Custom server paste names: a URL, a start command, an `mcpServers` JSON block
 * (or one entry of it), or `claude mcp add` / `claude mcp add-json` / `codex mcp add` lines.
 * Later servers with a name already taken replace the earlier one. Throws when it names none.
 */
export function parseMcpServersPaste(
  source: string,
  platform: NodeJS.Platform,
  t: CopyTranslate = englishTranslate
): BotToolServer[] {
  const text = source.trim()
  let servers: BotToolServer[]
  if (/^[{"]/.test(text)) {
    const read = pastedConfigServers(text)
    if (read === null) {
      throw new Error(t('mcpServers.paste.badJson', 'Check the pasted JSON: it doesn’t parse.'))
    }
    servers = read.map((entry) => entry.server)
  } else {
    servers = text
      // Shell line continuations join one command written over several lines.
      .replace(/\\\r?\n/g, ' ')
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^\$\s+/, ''))
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => pastedLineServer(line, platform, t))
  }
  const byName = new Map(servers.map((server) => [server.name, server]))
  if (byName.size === 0) {
    throw new Error(
      t(
        'mcpServers.paste.none',
        'Orca found no server it can add. SSE servers and servers that read tokens from the environment aren’t supported.'
      )
    )
  }
  return [...byName.values()]
}

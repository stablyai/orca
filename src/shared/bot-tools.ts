// A bot's tools (MCP servers): its own, kept in its home folder through its agent's own per-folder
// mechanism, beside the ones it inherits from its owner's Claude Code or Codex.
import * as z from 'zod'
import type { BotToolSignInStatus } from './bot-tool-sign-in'
import type { BotAgent } from './bot-types'

export const BOT_TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const BotToolName = z.string().regex(BOT_TOOL_NAME_PATTERN)

/** One of the bot's own servers, as its agent's config holds it. */
export const BOT_TOOL_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
export const BOT_TOOL_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const Text = z
  .string()
  .max(4096)
  .refine((value) => !value.includes('\0'))
export const BotToolUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value)
      return (
        /^https?:\/\//i.test(value) &&
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password
      )
    } catch {
      return false
    }
  }, 'Use an HTTP or HTTPS URL without embedded credentials')
const Executable = Text.pipe(z.string().min(1).max(1024)).refine(
  (value) => value.trim() === value && !/[\r\n]/.test(value),
  'Enter one executable path'
)
export const BotToolServerSchema = z.union([
  z.object({
    name: BotToolName,
    url: BotToolUrl,
    transport: z.literal('http').optional(),
    headers: z
      .record(
        z.string().regex(BOT_TOOL_HEADER_NAME_PATTERN),
        Text.refine((value) => !/[\r\n]/.test(value))
      )
      .optional(),
    /** Its headers, kept by the host outside the bot's folder; the agent reaches it through Orca's relay. */
    credential: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,64}$/)
      .optional()
  }),
  z.object({
    name: BotToolName,
    command: Executable,
    args: z.array(Text).max(64),
    env: z.record(z.string().regex(BOT_TOOL_ENV_NAME_PATTERN), Text).optional()
  })
])
export type BotToolServer = z.infer<typeof BotToolServerSchema>

const SecretRow = z
  .strictObject({
    key: z.string().min(1).max(256),
    value: Text.optional(),
    keep: z.literal(true).optional()
  })
  .refine(
    (row) => (row.keep === true) !== (row.value !== undefined),
    'Enter a value or keep a saved value'
  )
const Secrets = z.array(SecretRow).max(64)
export const BotToolInputSchema = z.union([
  z.strictObject({
    name: BotToolName,
    url: BotToolUrl,
    transport: z.literal('http'),
    headers: Secrets
  }),
  z.strictObject({
    name: BotToolName,
    command: Executable,
    args: z.array(Text).max(64),
    env: Secrets
  })
])
export type BotToolInput = z.infer<typeof BotToolInputSchema>
export function botToolInputError(input: BotToolInput, platform: NodeJS.Platform): string | null {
  if (!BotToolInputSchema.safeParse(input).success) {
    return 'Enter a valid server name and URL or executable.'
  }
  const remote = 'url' in input
  const rows = remote ? input.headers : input.env
  const names = rows.map((row) =>
    remote || platform === 'win32' ? row.key.toLowerCase() : row.key
  )
  if (new Set(names).size !== rows.length) {
    return 'Each header or environment name must be unique.'
  }
  if (
    rows.some(
      (row) =>
        !(remote ? BOT_TOOL_HEADER_NAME_PATTERN : BOT_TOOL_ENV_NAME_PATTERN).test(row.key) ||
        (!row.keep && !row.value) ||
        (remote && /[\r\n]/.test(row.value ?? ''))
    )
  ) {
    return 'Enter a valid name and value for every row, or remove the row.'
  }
  return null
}

export type BotToolSecretInput = z.infer<typeof SecretRow>
export type BotToolMaskedSecret = { key: string; configured: boolean }
export type BotToolDetails = {
  version: string
  server: { name: string } & (
    | { url: string; transport: 'http'; headers: BotToolMaskedSecret[] }
    | { command: string; args: string[]; env: BotToolMaskedSecret[] }
  )
}
export type BotToolContext = {
  folder: string
  platform: NodeJS.Platform
  agent: BotAgent
}

/** What a row says is wrong; a working tool shows nothing. */
export type BotToolProblem = { kind: 'sign-in' | 'failed' | 'unconfirmed'; detail?: string }

export type BotOwnTool = {
  name: string
  /** The URL, or the command line that starts it. */
  detail: string
  /** Signs in in a browser through its agent's CLI (a remote server); a command never does. */
  remote: boolean
  /** Present only on a tool Orca signs in to itself, whichever agent the bot runs. */
  signIn?: BotToolSignInStatus
}

/** A tool the bot gets from its owner's own config; read-only here. */
export type BotInheritedTool = { name: string; plugin?: true }

export type BotTools = {
  agent: BotAgent
  own: BotOwnTool[]
  /** Read from Claude Code's or Codex's config; another agent's own config isn't read, so none. */
  inherited: BotInheritedTool[]
}

export const botToolDetail = (server: BotToolServer): string =>
  'url' in server ? server.url : [server.command, ...server.args].join(' ')

// Words a package or host name carries that say nothing about which tool it is.
const NAME_NOISE = new Set([
  'mcp',
  'server',
  'servers',
  'api',
  'www',
  'app',
  'com',
  'io',
  'dev',
  'ai'
])

const meaningful = (words: readonly string[]): string =>
  words
    .map((word) => word.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter((word) => word && !NAME_NOISE.has(word))
    .join('-')
    .slice(0, 64)

/** A short name from a URL's host or a command's package: mcp.notion.com → notion. */
export function botToolNameFrom(detail: string): string {
  let name: string
  try {
    name = meaningful(new URL(detail).hostname.split('.'))
  } catch {
    const parts = detail.trim().split(/\s+/)
    const pkg = parts.find((part, index) => index > 0 && !part.startsWith('-')) ?? parts[0] ?? ''
    // The package's own name, else its scope (@sentry/mcp-server → sentry); never its version.
    const [scope, base] = pkg.startsWith('@') ? pkg.slice(1).split('/') : [undefined, pkg]
    const words = (base ?? '').replace(/@[^@]*$/, '').split(/[-_.]/)
    name = meaningful(words) || meaningful([scope ?? ''])
  }
  return BOT_TOOL_NAME_PATTERN.test(name) ? name : 'tool'
}

/** `name`, or the first of name-2, name-3… that nothing in `taken` uses. */
export function freeBotToolName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) {
    return name
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${name.slice(0, 64 - `-${n}`.length)}-${n}`
    if (!taken.has(candidate)) {
      return candidate
    }
  }
}

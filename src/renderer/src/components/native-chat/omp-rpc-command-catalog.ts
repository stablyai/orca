// Merges OMP's live slash-command catalog into the composer's static one.
// Live commands arrive over a wire, so unlike the curated per-agent catalogs
// they are untrusted input: a name IS the dispatch token typed into the PTY,
// so anything that isn't a single safe token is dropped rather than sanitized.

import type { AgentType } from '../../../../shared/agent-status-types'
import { resolveNativeChatTranscriptAgent } from '../../../../shared/native-chat-agent-support'
import type { OmpRpcSlashCommand } from '../../../../shared/omp-rpc-protocol'
import type { SlashCommandSuggestion } from '../../../../shared/native-chat-slash-commands'
import {
  isSafeDisplayCharacter,
  stripUnsafeDisplayCharacters
} from '../../../../shared/skill-display-text'

/** True when this pane's agent is OMP, the only agent with an RPC catalog.
 *  Accepts null: a caller (e.g. the TerminalPane-anchored ownership hook)
 *  may not have resolved an agent for the pane yet, which is never OMP.
 *  Lives here rather than beside the hook so the routing modules can ask it
 *  without importing the renderer store. */
export function isOmpRpcCatalogAgent(agent: AgentType | null): boolean {
  return resolveNativeChatTranscriptAgent(agent) === 'omp'
}

const MAX_COMMAND_NAME_LENGTH = 200
const MAX_DESCRIPTION_LENGTH = 240

function isTokenSafeCommandName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_COMMAND_NAME_LENGTH &&
    !/\s/u.test(name) &&
    [...name].every(isSafeDisplayCharacter)
  )
}

/** OMP may publish names with or without the leading slash; the composer's
 *  catalog is slash-less and re-adds it at dispatch. */
function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, '')
}

function describe(command: OmpRpcSlashCommand): string | undefined {
  const description = command.description?.trim() ?? ''
  const hint = command.input?.hint?.trim() ?? ''
  const combined = hint ? (description ? `${description} — ${hint}` : hint) : description
  return combined
    ? stripUnsafeDisplayCharacters(combined).slice(0, MAX_DESCRIPTION_LENGTH)
    : undefined
}

/** Live catalog wins per name; static entries survive only where live has no
 *  command of that name, so enabling RPC can never shrink the menu. */
export function mergeOmpRpcCommands(
  staticCommands: readonly SlashCommandSuggestion[],
  liveCommands: readonly OmpRpcSlashCommand[] | null
): readonly SlashCommandSuggestion[] {
  if (!liveCommands || liveCommands.length === 0) {
    return staticCommands
  }
  const merged = new Map<string, SlashCommandSuggestion>()
  for (const command of liveCommands) {
    const name = normalizeCommandName(command.name ?? '')
    if (!isTokenSafeCommandName(name) || merged.has(name)) {
      continue
    }
    const description = describe(command)
    merged.set(name, { name, ...(description ? { description } : {}) })
  }
  if (merged.size === 0) {
    return staticCommands
  }
  for (const command of staticCommands) {
    if (!merged.has(command.name)) {
      merged.set(command.name, command)
    }
  }
  return [...merged.values()]
}

/**
 * The live catalog the composer's `/` menu should show. The owning session's
 * published catalog wins whenever it has one: OMP republishes
 * `available_commands_update` on every command-metadata change (a reloaded
 * plugin, a newly registered extension command), while the probe snapshot is
 * fetched once per cwd and cached for the app's life. It is also the exact set
 * `isOmpRpcExecutableCommand` gates routing on, so preferring it stops the menu
 * from offering commands the session route would then refuse.
 *
 * Null means "no live catalog" so `mergeOmpRpcCommands` keeps the static menu
 * rather than emptying the picker.
 */
export function selectOmpRpcLiveCommands(
  sessionCommands: readonly OmpRpcSlashCommand[] | null | undefined,
  probeCommands: readonly OmpRpcSlashCommand[] | null | undefined
): readonly OmpRpcSlashCommand[] | null {
  if (sessionCommands && sessionCommands.length > 0) {
    return sessionCommands
  }
  return probeCommands && probeCommands.length > 0 ? probeCommands : null
}

/** The published catalog reduced to the two questions routing asks of it. */
export type OmpRpcExecutableCommands = {
  /** Every dispatch name, whatever source published it. */
  readonly names: ReadonlySet<string>
  /** The names OMP resolves through its colon-splitting builtin lookup, so
   *  `/model:opus` may route on the head alone. Builtins only — every other
   *  source is looked up on the whole pre-whitespace token. */
  readonly colonSplitNames: ReadonlySet<string>
}

/**
 * Every name OMP will actually dispatch over RPC. The catalog is the
 * executable set by construction: `buildAvailableSlashCommands` skips any
 * builtin without a text-mode `handle`, so a TUI-only command (`/clear`) is
 * absent, and `lookupBuiltinSlashCommand` resolves aliases through the same
 * table the dispatcher uses — hence names AND aliases.
 *
 * `source` splits out the builtins because they are the only source reached
 * through `parseSlashCommand`, which cuts the name at the first colon.
 * Unproven builtin-ness (an OMP old enough to publish the ACP projection
 * carries no `source`) is treated as not-builtin, so a colon-namespaced draft
 * degrades to the probe/PTY route rather than being sent as a prompt OMP would
 * hand straight to the model.
 *
 * Null means "unknown", not "empty": an absent or empty publish is a missing
 * catalog, which proves nothing either way — see `isOmpRpcExecutableCommand`.
 */
export function ompRpcExecutableCommands(
  commands: readonly OmpRpcSlashCommand[] | null | undefined
): OmpRpcExecutableCommands | null {
  if (!commands || commands.length === 0) {
    return null
  }
  const names = new Set<string>()
  const colonSplitNames = new Set<string>()
  for (const command of commands) {
    for (const candidate of [command.name, ...(command.aliases ?? [])]) {
      const name = normalizeCommandName(candidate ?? '')
      if (name) {
        names.add(name)
        if (command.source === 'builtin') {
          colonSplitNames.add(name)
        }
      }
    }
  }
  return names.size > 0 ? { names, colonSplitNames } : null
}

/** The invoked command token: everything between the leading slash and the
 *  first whitespace. Args are dropped, the colon is not — a skill keeps its
 *  full `skill:<name>` token. */
function invokedCommandToken(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) {
    return null
  }
  const body = trimmed.slice(1)
  const whitespace = body.search(/\s/u)
  return (whitespace === -1 ? body : body.slice(0, whitespace)) || null
}

/**
 * Whether OMP would run this draft as a command over RPC rather than hand it
 * to the model. Matched case-sensitively because upstream's lookup is a plain
 * Map, and against the full token first — a skill is registered under the whole
 * `skill:<name>`.
 *
 * The pre-colon head is a *builtin-only* fallback: `parseSlashCommand` cuts at
 * the first colon or whitespace and only `executeAcpBuiltinSlashCommand` uses
 * it, so `/model:opus` runs builtin `model`. Extension, custom, MCP-prompt and
 * file commands are looked up on the whole pre-whitespace token, so a
 * `/deploy:prod` draft would miss the published `deploy` and be handed to the
 * model as a prompt — it must not route here.
 *
 * An unknown or empty catalog answers false. Routing to the session asserts
 * that OMP will *execute* the command; OMP falls through to `session.prompt`
 * for anything its lookup misses, so an unproven `/clear` would silently reach
 * the model. Callers treat a false here as "no proof yet", not "never" — the
 * probe and PTY routes still apply.
 */
export function isOmpRpcExecutableCommand(
  text: string,
  executableCommands: OmpRpcExecutableCommands | null | undefined
): boolean {
  if (!executableCommands || executableCommands.names.size === 0) {
    return false
  }
  const token = invokedCommandToken(text)
  if (!token) {
    return false
  }
  if (executableCommands.names.has(token)) {
    return true
  }
  const colon = token.indexOf(':')
  return colon > 0 && executableCommands.colonSplitNames.has(token.slice(0, colon))
}

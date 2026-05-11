/* eslint-disable max-lines -- Why: this module is the canonical, transport-
   agnostic agent-hook listener. The HTTP request parser, payload normalizer,
   per-CLI extractors, and on-disk endpoint-file writer all share invariants
   (size caps, warn-once Sets, shell-safe value rules) that must not drift
   between Orca's main process and the relay. Splitting by line count would
   force the same invariants to be re-derived in two places. */

// Why: extracted from `src/main/agent-hooks/server.ts` so the relay can host
// the same listener pipeline on the remote without dragging Electron in. The
// module uses only Node builtins (http/fs/crypto/net/path/url/os) — none of
// which pull `electron` — so it is safe to import from `src/relay/`. See
// docs/design/agent-status-over-ssh.md §3 ("relay normalizes; Orca routes").
import type { IncomingMessage } from 'http'
import { randomUUID } from 'crypto'
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { join } from 'path'

import { parseAgentStatusPayload, type ParsedAgentStatusPayload } from './agent-status-types'
import { ORCA_HOOK_PROTOCOL_VERSION } from './agent-hook-types'
import type { AgentHookSource } from './agent-hook-relay'

/** Maximum request body size accepted by the listener (1 MB). */
export const HOOK_REQUEST_MAX_BYTES = 1_000_000

/** Bound the warn-once Sets so a buggy/malicious local client that varies its
 *  `version` / `env` fields per request cannot grow them without bound for the
 *  process lifetime. */
const MAX_WARNED_KEYS = 32

/** Slowloris cap: drop requests that have not finished sending after 5 s. */
export const HOOK_REQUEST_SLOWLORIS_MS = 5_000

/** Bound paneKey size — `${tabId}:${paneId}` is well under 200 chars in
 *  practice; cap defends per-pane caches against pathological input. */
export const MAX_PANE_KEY_LEN = 200

/** Per-listener-instance state that holds caches needing per-PTY teardown
 *  (last prompt, last tool snapshot, last status replay). Both Orca's main
 *  process and the relay get their own instance — they never share. */
export type HookListenerState = {
  warnedVersions: Set<string>
  warnedEnvs: Set<string>
  lastPromptByPaneKey: Map<string, string>
  lastToolByPaneKey: Map<string, ToolSnapshot>
  lastStatusByPaneKey: Map<string, AgentHookEventPayload>
}

export function createHookListenerState(): HookListenerState {
  return {
    warnedVersions: new Set(),
    warnedEnvs: new Set(),
    lastPromptByPaneKey: new Map(),
    lastToolByPaneKey: new Map(),
    lastStatusByPaneKey: new Map()
  }
}

export function clearPaneCacheState(state: HookListenerState, paneKey: string): void {
  state.lastPromptByPaneKey.delete(paneKey)
  state.lastToolByPaneKey.delete(paneKey)
  state.lastStatusByPaneKey.delete(paneKey)
}

export function clearAllListenerCaches(state: HookListenerState): void {
  state.lastPromptByPaneKey.clear()
  state.lastToolByPaneKey.clear()
  state.lastStatusByPaneKey.clear()
  state.warnedVersions.clear()
  state.warnedEnvs.clear()
}

export type AgentHookEventPayload = {
  paneKey: string
  tabId?: string
  worktreeId?: string
  /** Identifies the SSH connection the event arrived on, or null for local.
   *  Stamped only on the remote-ingest path (Orca's `ingestRemote`); the
   *  HTTP path always sets null because it cannot know which mux a request
   *  came from. See docs/design/agent-status-over-ssh.md §5. */
  connectionId: string | null
  payload: ParsedAgentStatusPayload
}

// ─── Body parsing ───────────────────────────────────────────────────

export function parseFormEncodedBody(body: string): Record<string, string> {
  const params = new URLSearchParams(body)
  const parsed: Record<string, string> = {}
  for (const [key, value] of params.entries()) {
    parsed[key] = value
  }
  return parsed
}

export function readRequestBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let byteLength = 0
    let settled = false
    req.on('data', (chunk: Buffer) => {
      if (settled) {
        return
      }
      // Why: check size in bytes (not UTF-16 code units) and stop accumulating
      // after rejection so a malicious client cannot push memory past the cap.
      if (byteLength + chunk.length > HOOK_REQUEST_MAX_BYTES) {
        settled = true
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      byteLength += chunk.length
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) {
        return
      }
      settled = true
      try {
        // Why: decode once via Buffer.concat so multi-byte UTF-8 characters
        // that straddle a chunk boundary are reassembled correctly.
        const body = chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : ''
        const contentType = req.headers['content-type'] ?? ''
        if (typeof contentType === 'string' && contentType.includes('application/json')) {
          resolve(body ? JSON.parse(body) : {})
          return
        }
        if (
          typeof contentType === 'string' &&
          contentType.includes('application/x-www-form-urlencoded')
        ) {
          resolve(parseFormEncodedBody(body))
          return
        }
        // Why: existing managed scripts POST JSON; updated POSIX scripts POST
        // form-encoded. Default to JSON for unknown content types.
        resolve(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', (err) => {
      if (settled) {
        return
      }
      settled = true
      reject(err)
    })
    // Why: req.destroy() (called by the slowloris timer) emits 'close' but
    // not 'end'/'error'. Without this handler the promise would never settle
    // and the chunk buffers would be retained for the process lifetime.
    req.on('close', () => {
      if (settled) {
        return
      }
      settled = true
      reject(new Error('aborted'))
    })
  })
}

// ─── Per-pane field caches + extractors ─────────────────────────────

function extractPromptText(hookPayload: Record<string, unknown>): string {
  const candidateKeys = ['prompt', 'user_prompt', 'userPrompt', 'message']
  for (const key of candidateKeys) {
    const value = hookPayload[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      // Why: trim so prompts match what readStringField produces elsewhere —
      // surrounding whitespace would otherwise leak into UI and caches.
      return value.trim()
    }
  }
  // Why: OpenCode's plugin sends MessagePart events with { role, text }. When
  // role === 'user', the text *is* the prompt — surface it even though
  // OpenCode has no UserPromptSubmit-equivalent.
  if (hookPayload.role === 'user' && typeof hookPayload.text === 'string') {
    const trimmed = hookPayload.text.trim()
    if (trimmed.length > 0) {
      return trimmed
    }
  }
  return ''
}

function resolvePrompt(
  state: HookListenerState,
  paneKey: string,
  promptText: string,
  options?: { resetOnNewTurn?: boolean }
): string {
  if (options?.resetOnNewTurn) {
    state.lastPromptByPaneKey.delete(paneKey)
  }
  if (promptText) {
    state.lastPromptByPaneKey.set(paneKey, promptText)
    return promptText
  }
  return state.lastPromptByPaneKey.get(paneKey) ?? ''
}

export type ToolSnapshot = {
  toolName?: string
  toolInput?: string
  lastAssistantMessage?: string
}

function resolveToolState(
  state: HookListenerState,
  paneKey: string,
  update: ToolSnapshot,
  options: { resetOnNewTurn: boolean }
): ToolSnapshot {
  if (options.resetOnNewTurn) {
    state.lastToolByPaneKey.delete(paneKey)
  }
  const previous = state.lastToolByPaneKey.get(paneKey) ?? {}
  const merged: ToolSnapshot = {
    toolName: update.toolName ?? previous.toolName,
    toolInput: update.toolInput ?? previous.toolInput,
    lastAssistantMessage: update.lastAssistantMessage ?? previous.lastAssistantMessage
  }
  state.lastToolByPaneKey.set(paneKey, merged)
  return merged
}

const TOOL_INPUT_KEYS_BY_TOOL: Record<string, readonly string[]> = {
  Read: ['file_path', 'filePath', 'path'],
  Write: ['file_path', 'filePath', 'path'],
  Edit: ['file_path', 'filePath', 'path'],
  MultiEdit: ['file_path', 'filePath', 'path'],
  NotebookEdit: ['file_path', 'filePath', 'path'],
  Bash: ['command'],
  Glob: ['pattern'],
  Grep: ['pattern'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  read_file: ['file_path', 'path'],
  write_file: ['file_path', 'path'],
  read_many_files: ['file_path', 'paths', 'path'],
  edit_file: ['file_path', 'path'],
  replace: ['file_path', 'path'],
  run_shell_command: ['command'],
  glob: ['pattern'],
  search_file_content: ['pattern'],
  web_fetch: ['url'],
  google_web_search: ['query'],
  exec_command: ['cmd', 'command'],
  shell_command: ['cmd', 'command'],
  apply_patch: ['path', 'file_path'],
  view_image: ['path', 'file_path'],
  bash: ['command'],
  read: ['path', 'file_path'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  grep: ['pattern'],
  web_search: ['query'],
  fetch_content: ['url']
}

function deriveToolInputPreview(
  toolName: string | undefined,
  toolInput: unknown
): string | undefined {
  if (typeof toolInput === 'string') {
    return toolInput
  }
  if (typeof toolInput !== 'object' || toolInput === null) {
    return undefined
  }
  if (!toolName) {
    return undefined
  }
  const keys = TOOL_INPUT_KEYS_BY_TOOL[toolName]
  if (!keys) {
    return undefined
  }
  const record = toolInput as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
    }
  }
  return undefined
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function extractToolResponseText(toolResponse: unknown): string | undefined {
  if (typeof toolResponse === 'string' && toolResponse.length > 0) {
    return toolResponse
  }
  if (typeof toolResponse !== 'object' || toolResponse === null) {
    return undefined
  }
  const record = toolResponse as Record<string, unknown>
  const content = record.content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'object' && part !== null) {
        const text = (part as Record<string, unknown>).text
        if (typeof text === 'string' && text.trim().length > 0) {
          return text
        }
      }
    }
  }
  const text = record.text
  if (typeof text === 'string' && text.trim().length > 0) {
    return text
  }
  return undefined
}

const TRANSCRIPT_CHUNK_BYTES = 64 * 1024
const TRANSCRIPT_MAX_SCAN_BYTES = 4 * 1024 * 1024

function extractAssistantTextFromLine(line: string): string | undefined {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof entry !== 'object' || entry === null) {
    return undefined
  }
  const record = entry as Record<string, unknown>
  const nestedMessage = record.message as Record<string, unknown> | undefined
  const role = record.role ?? nestedMessage?.role
  if (role !== 'assistant') {
    return undefined
  }
  const content = (nestedMessage ?? record).content
  if (typeof content === 'string' && content.trim().length > 0) {
    return content
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'object' && part !== null) {
        const text = (part as Record<string, unknown>).text
        if (typeof text === 'string' && text.trim().length > 0) {
          return text
        }
      }
    }
  }
  return undefined
}

function readLastAssistantFromTranscript(transcriptPath: unknown): string | undefined {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    return undefined
  }
  try {
    const stats = statSync(transcriptPath)
    const size = stats.size
    if (size <= 0) {
      return undefined
    }
    const fd = openSync(transcriptPath, 'r')
    try {
      let carryBytes: Buffer = Buffer.alloc(0)
      let bytesRead = 0
      while (bytesRead < size && bytesRead < TRANSCRIPT_MAX_SCAN_BYTES) {
        const chunkSize = Math.min(size - bytesRead, TRANSCRIPT_CHUNK_BYTES)
        const position = size - bytesRead - chunkSize
        const buffer = Buffer.alloc(chunkSize)
        let filled = 0
        while (filled < chunkSize) {
          const n = readSync(fd, buffer, filled, chunkSize - filled, position + filled)
          if (n === 0) {
            break
          }
          filled += n
        }
        const n = filled
        bytesRead += n
        if (n === 0) {
          break
        }
        const combined = Buffer.concat([buffer.subarray(0, n), carryBytes])
        const atStart = bytesRead >= size
        const firstNewline = combined.indexOf(0x0a)
        let completeRegion: Buffer
        let nextCarry: Buffer
        if (atStart) {
          completeRegion = combined
          nextCarry = Buffer.alloc(0)
        } else if (firstNewline === -1) {
          completeRegion = Buffer.alloc(0)
          nextCarry = combined
        } else {
          nextCarry = combined.subarray(0, firstNewline)
          completeRegion = combined.subarray(firstNewline + 1)
        }
        if (completeRegion.length > 0) {
          const lines = completeRegion.toString('utf8').split('\n')
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim()
            if (line.length === 0) {
              continue
            }
            const extracted = extractAssistantTextFromLine(line)
            if (extracted !== undefined) {
              return extracted
            }
          }
        }
        carryBytes = nextCarry
      }
      return undefined
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

function extractClaudeToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  const update: ToolSnapshot = {}
  if (
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse' ||
    eventName === 'PostToolUseFailure'
  ) {
    const toolName = readString(hookPayload, 'tool_name')
    update.toolName = toolName
    update.toolInput = deriveToolInputPreview(toolName, hookPayload.tool_input)
  }
  if (eventName === 'PostToolUse') {
    const responseText = extractToolResponseText(hookPayload.tool_response)
    if (responseText) {
      update.lastAssistantMessage = responseText
    }
  }
  if (eventName === 'PostToolUseFailure') {
    const errorText =
      extractToolResponseText(hookPayload.tool_response) ??
      readString(hookPayload, 'error') ??
      readString(hookPayload, 'message')
    if (errorText) {
      update.lastAssistantMessage = errorText
    }
  }
  if (eventName === 'Stop') {
    const direct = readString(hookPayload, 'last_assistant_message')
    if (direct) {
      update.lastAssistantMessage = direct
    } else {
      const lastFromTranscript = readLastAssistantFromTranscript(hookPayload.transcript_path)
      if (lastFromTranscript) {
        update.lastAssistantMessage = lastFromTranscript
      }
    }
  }
  return update
}

function extractCodexToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (eventName === 'PreToolUse' || eventName === 'PostToolUse') {
    const toolName = readString(hookPayload, 'tool_name') ?? readString(hookPayload, 'name')
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      deriveToolInputPreview(toolName, hookPayload.input) ??
      deriveToolInputPreview(toolName, hookPayload.arguments)
    return { toolName, toolInput }
  }
  if (eventName === 'Stop') {
    const message = readString(hookPayload, 'last_assistant_message')
    if (message) {
      return { lastAssistantMessage: message }
    }
  }
  return {}
}

function extractGeminiToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (eventName === 'PreToolUse' || eventName === 'PostToolUse' || eventName === 'AfterTool') {
    const toolName = readString(hookPayload, 'tool_name') ?? readString(hookPayload, 'name')
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      deriveToolInputPreview(toolName, hookPayload.args) ??
      deriveToolInputPreview(toolName, hookPayload.input)
    return { toolName, toolInput }
  }
  if (eventName === 'AfterAgent') {
    const message = readString(hookPayload, 'prompt_response')
    if (message) {
      return { lastAssistantMessage: message }
    }
  }
  return {}
}

function extractOpenCodeToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (eventName === 'MessagePart' && hookPayload.role === 'assistant') {
    const text = readString(hookPayload, 'text')
    if (text) {
      return { lastAssistantMessage: text }
    }
  }
  return {}
}

function extractCursorToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (
    eventName === 'preToolUse' ||
    eventName === 'postToolUse' ||
    eventName === 'postToolUseFailure'
  ) {
    const toolName = readString(hookPayload, 'tool_name')
    const toolInput = deriveToolInputPreview(toolName, hookPayload.tool_input)
    const update: ToolSnapshot = { toolName, toolInput }
    if (eventName === 'postToolUse') {
      const responseText = extractToolResponseText(hookPayload.tool_output)
      if (responseText) {
        update.lastAssistantMessage = responseText
      }
    }
    if (eventName === 'postToolUseFailure') {
      const errorText =
        extractToolResponseText(hookPayload.tool_output) ??
        readString(hookPayload, 'error_message') ??
        readString(hookPayload, 'error')
      if (errorText) {
        update.lastAssistantMessage = errorText
      }
    }
    return update
  }
  if (eventName === 'beforeShellExecution') {
    const command = readString(hookPayload, 'command')
    return { toolName: 'Shell', toolInput: command }
  }
  if (eventName === 'beforeMCPExecution') {
    const toolName = readString(hookPayload, 'tool_name') ?? 'MCP'
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      readString(hookPayload, 'command') ??
      readString(hookPayload, 'url')
    return { toolName, toolInput }
  }
  if (eventName === 'afterAgentResponse') {
    const text = readString(hookPayload, 'text')
    if (text) {
      return { lastAssistantMessage: text }
    }
  }
  return {}
}

function extractPiToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (
    eventName === 'tool_call' ||
    eventName === 'tool_execution_start' ||
    eventName === 'tool_execution_end'
  ) {
    const toolName = readString(hookPayload, 'tool_name')
    const toolInput = deriveToolInputPreview(toolName, hookPayload.tool_input)
    return { toolName, toolInput }
  }
  if (eventName === 'message_end' && hookPayload.role === 'assistant') {
    const text = readString(hookPayload, 'text')
    if (text) {
      return { lastAssistantMessage: text }
    }
  }
  return {}
}

function isNewTurnEvent(source: AgentHookSource, eventName: unknown): boolean {
  // Why: exhaustive switch so adding a 7th source to AgentHookSource fails
  // typecheck here instead of silently falling through to `false`.
  switch (source) {
    case 'claude':
      return eventName === 'UserPromptSubmit'
    case 'codex':
      return eventName === 'SessionStart' || eventName === 'UserPromptSubmit'
    case 'gemini':
      return eventName === 'BeforeAgent'
    case 'opencode':
      return false
    case 'cursor':
      return eventName === 'beforeSubmitPrompt' || eventName === 'sessionStart'
    case 'pi':
      return eventName === 'before_agent_start'
    default: {
      const _exhaustive: never = source
      void _exhaustive
      return false
    }
  }
}

function extractToolFields(
  source: AgentHookSource,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  // Why: exhaustive switch so adding a 7th source to AgentHookSource fails
  // typecheck here instead of silently routing through OpenCode's extractor.
  switch (source) {
    case 'claude':
      return extractClaudeToolFields(eventName, hookPayload)
    case 'codex':
      return extractCodexToolFields(eventName, hookPayload)
    case 'gemini':
      return extractGeminiToolFields(eventName, hookPayload)
    case 'opencode':
      return extractOpenCodeToolFields(eventName, hookPayload)
    case 'cursor':
      return extractCursorToolFields(eventName, hookPayload)
    case 'pi':
      return extractPiToolFields(eventName, hookPayload)
    default: {
      const _exhaustive: never = source
      void _exhaustive
      return {}
    }
  }
}

function normalizeClaudeEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const stateName =
    eventName === 'UserPromptSubmit' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse' ||
    eventName === 'PostToolUseFailure'
      ? 'working'
      : eventName === 'PermissionRequest'
        ? 'waiting'
        : eventName === 'Stop'
          ? 'done'
          : null

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('claude', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('claude', eventName) }
  )

  const interrupted =
    eventName === 'Stop' && hookPayload['is_interrupt'] === true ? true : undefined

  return parseAgentStatusPayload(
    JSON.stringify({
      state: stateName,
      prompt: resolvePrompt(state, paneKey, promptText, {
        resetOnNewTurn: isNewTurnEvent('claude', eventName)
      }),
      agentType: 'claude',
      toolName: snapshot.toolName,
      toolInput: snapshot.toolInput,
      lastAssistantMessage: snapshot.lastAssistantMessage,
      interrupted
    })
  )
}

function normalizeGeminiEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const stateName =
    eventName === 'BeforeAgent' ||
    eventName === 'AfterTool' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse'
      ? 'working'
      : eventName === 'AfterAgent'
        ? 'done'
        : null

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('gemini', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('gemini', eventName) }
  )

  return parseAgentStatusPayload(
    JSON.stringify({
      state: stateName,
      prompt: resolvePrompt(state, paneKey, promptText, {
        resetOnNewTurn: isNewTurnEvent('gemini', eventName)
      }),
      agentType: 'gemini',
      toolName: snapshot.toolName,
      toolInput: snapshot.toolInput,
      lastAssistantMessage: snapshot.lastAssistantMessage
    })
  )
}

function normalizeCodexEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const stateName =
    eventName === 'SessionStart' ||
    eventName === 'UserPromptSubmit' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse'
      ? 'working'
      : eventName === 'Stop'
        ? 'done'
        : null

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('codex', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('codex', eventName) }
  )

  return parseAgentStatusPayload(
    JSON.stringify({
      state: stateName,
      prompt: resolvePrompt(state, paneKey, promptText, {
        resetOnNewTurn: isNewTurnEvent('codex', eventName)
      }),
      agentType: 'codex',
      toolName: snapshot.toolName,
      toolInput: snapshot.toolInput,
      lastAssistantMessage: snapshot.lastAssistantMessage
    })
  )
}

function normalizeOpenCodeEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const stateName =
    eventName === 'SessionBusy' || eventName === 'MessagePart'
      ? 'working'
      : eventName === 'SessionIdle'
        ? 'done'
        : eventName === 'PermissionRequest' || eventName === 'AskUserQuestion'
          ? 'waiting'
          : null

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('opencode', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('opencode', eventName) }
  )

  return parseAgentStatusPayload(
    JSON.stringify({
      state: stateName,
      prompt: resolvePrompt(state, paneKey, promptText, {
        resetOnNewTurn: isNewTurnEvent('opencode', eventName)
      }),
      agentType: 'opencode',
      toolName: snapshot.toolName,
      toolInput: snapshot.toolInput,
      lastAssistantMessage: snapshot.lastAssistantMessage
    })
  )
}

function normalizeCursorEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const stateName =
    eventName === 'beforeSubmitPrompt' ||
    eventName === 'sessionStart' ||
    eventName === 'preToolUse' ||
    eventName === 'postToolUse' ||
    eventName === 'postToolUseFailure' ||
    eventName === 'afterAgentResponse'
      ? 'working'
      : eventName === 'stop' || eventName === 'sessionEnd'
        ? 'done'
        : eventName === 'beforeShellExecution' || eventName === 'beforeMCPExecution'
          ? 'waiting'
          : null

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('cursor', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('cursor', eventName) }
  )

  const interrupted =
    eventName === 'stop' &&
    typeof hookPayload.status === 'string' &&
    hookPayload.status !== 'completed'
      ? true
      : undefined

  return parseAgentStatusPayload(
    JSON.stringify({
      state: stateName,
      prompt: resolvePrompt(state, paneKey, promptText, {
        resetOnNewTurn: isNewTurnEvent('cursor', eventName)
      }),
      agentType: 'cursor',
      toolName: snapshot.toolName,
      toolInput: snapshot.toolInput,
      lastAssistantMessage: snapshot.lastAssistantMessage,
      interrupted
    })
  )
}

function normalizePiEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const stateName =
    eventName === 'before_agent_start' ||
    eventName === 'agent_start' ||
    eventName === 'tool_call' ||
    eventName === 'tool_execution_start' ||
    eventName === 'tool_execution_end' ||
    eventName === 'message_end'
      ? 'working'
      : eventName === 'agent_end' || eventName === 'session_shutdown'
        ? 'done'
        : null

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('pi', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('pi', eventName) }
  )

  return parseAgentStatusPayload(
    JSON.stringify({
      state: stateName,
      prompt: resolvePrompt(state, paneKey, promptText, {
        resetOnNewTurn: isNewTurnEvent('pi', eventName)
      }),
      agentType: 'pi',
      toolName: snapshot.toolName,
      toolInput: snapshot.toolInput,
      lastAssistantMessage: snapshot.lastAssistantMessage
    })
  )
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function normalizeHookPayload(
  state: HookListenerState,
  source: AgentHookSource,
  body: unknown,
  expectedEnv: string
): AgentHookEventPayload | null {
  if (typeof body !== 'object' || body === null) {
    return null
  }

  const record = body as Record<string, unknown>
  const paneKey = typeof record.paneKey === 'string' ? record.paneKey.trim() : ''
  const rawPayload = record.payload
  const hookPayload =
    typeof rawPayload === 'string'
      ? (() => {
          try {
            return JSON.parse(rawPayload)
          } catch {
            return null
          }
        })()
      : rawPayload
  if (
    !paneKey ||
    paneKey.length > MAX_PANE_KEY_LEN ||
    typeof hookPayload !== 'object' ||
    hookPayload === null
  ) {
    return null
  }

  const version = readStringField(record, 'version')
  if (
    version &&
    version !== ORCA_HOOK_PROTOCOL_VERSION &&
    !state.warnedVersions.has(version) &&
    state.warnedVersions.size < MAX_WARNED_KEYS
  ) {
    state.warnedVersions.add(version)
    console.warn(
      `[agent-hooks] received hook v${version}; server expects v${ORCA_HOOK_PROTOCOL_VERSION}. ` +
        'Reinstall agent hooks from Settings to upgrade the managed script.'
    )
  }

  const clientEnv = readStringField(record, 'env')
  if (clientEnv && clientEnv !== expectedEnv) {
    const key = `${clientEnv}->${expectedEnv}`
    if (!state.warnedEnvs.has(key) && state.warnedEnvs.size < MAX_WARNED_KEYS) {
      state.warnedEnvs.add(key)
      console.warn(
        `[agent-hooks] received ${clientEnv} hook on ${expectedEnv} server. ` +
          'Likely a stale terminal from another Orca install.'
      )
    }
  }

  const tabId = readStringField(record, 'tabId')
  const worktreeId = readStringField(record, 'worktreeId')

  const eventName = (hookPayload as Record<string, unknown>).hook_event_name
  const promptText = extractPromptText(hookPayload as Record<string, unknown>)
  const hookPayloadRecord = hookPayload as Record<string, unknown>
  // Why: exhaustive switch so adding a 7th source to AgentHookSource fails
  // typecheck here instead of silently routing through OpenCode's normalizer.
  let payload: ParsedAgentStatusPayload | null
  switch (source) {
    case 'claude':
      payload = normalizeClaudeEvent(state, eventName, promptText, paneKey, hookPayloadRecord)
      break
    case 'codex':
      payload = normalizeCodexEvent(state, eventName, promptText, paneKey, hookPayloadRecord)
      break
    case 'gemini':
      payload = normalizeGeminiEvent(state, eventName, promptText, paneKey, hookPayloadRecord)
      break
    case 'opencode':
      payload = normalizeOpenCodeEvent(state, eventName, promptText, paneKey, hookPayloadRecord)
      break
    case 'cursor':
      payload = normalizeCursorEvent(state, eventName, promptText, paneKey, hookPayloadRecord)
      break
    case 'pi':
      payload = normalizePiEvent(state, eventName, promptText, paneKey, hookPayloadRecord)
      break
    default: {
      const _exhaustive: never = source
      void _exhaustive
      payload = null
    }
  }

  // Why: connectionId stays null at the listener layer. The local server keeps
  // it null; the relay forwards null on the wire and Orca's `ingestRemote`
  // stamps the real value from `mux` identity on receive. See
  // docs/design/agent-status-over-ssh.md §5.
  return payload ? { paneKey, tabId, worktreeId, connectionId: null, payload } : null
}

// ─── URL routing ────────────────────────────────────────────────────

export const HOOK_SOURCE_BY_PATHNAME: Readonly<Record<string, AgentHookSource>> = Object.freeze({
  '/hook/claude': 'claude',
  '/hook/codex': 'codex',
  '/hook/gemini': 'gemini',
  '/hook/opencode': 'opencode',
  '/hook/cursor': 'cursor',
  '/hook/pi': 'pi'
})

export function resolveHookSource(pathname: string): AgentHookSource | null {
  return HOOK_SOURCE_BY_PATHNAME[pathname] ?? null
}

// ─── Endpoint-file writing ──────────────────────────────────────────

export function getEndpointFileName(): string {
  // Why: per-platform extension lets hook scripts source the file natively
  // (`. "$file"` POSIX, `call "%file%"` Windows). The OpenCode plugin's regex
  // accepts both shapes already.
  return process.platform === 'win32' ? 'endpoint.cmd' : 'endpoint.env'
}

export function isShellSafeEndpointValue(value: string): boolean {
  // Why: every value in the endpoint file is sourced as shell. The `+`
  // quantifier rejects empty strings as defense-in-depth — a sourced empty
  // `KEY=` would clear the env var in the sourcing shell.
  return /^[A-Za-z0-9._:/-]+$/.test(value)
}

export type EndpointFileFields = {
  port: number
  token: string
  env: string
  version: string
}

/** Atomically write the endpoint file at `endpointDir/<getEndpointFileName()>`.
 *  Returns true on success, false on any error (caller may fall back to PTY
 *  env). Mirrors `AgentHookServer.writeEndpointFile` and is shared verbatim by
 *  the relay's adapter. */
export function writeEndpointFile(
  endpointDir: string,
  finalPath: string,
  fields: EndpointFileFields
): boolean {
  const tmpPath = join(endpointDir, `.endpoint-${process.pid}-${randomUUID()}.tmp`)
  const prefix = process.platform === 'win32' ? 'set ' : ''
  const valuesToWrite: [string, string][] = [
    ['ORCA_AGENT_HOOK_PORT', String(fields.port)],
    ['ORCA_AGENT_HOOK_TOKEN', fields.token],
    ['ORCA_AGENT_HOOK_ENV', fields.env],
    ['ORCA_AGENT_HOOK_VERSION', fields.version]
  ]
  for (const [key, value] of valuesToWrite) {
    if (!isShellSafeEndpointValue(value)) {
      console.error(
        `[agent-hooks] refusing to write endpoint file: ${key} contains ` +
          'characters unsafe for shell sourcing. Falling back to PTY env.'
      )
      return false
    }
  }
  const lines = [...valuesToWrite.map(([key, value]) => `${prefix}${key}=${value}`), '']
  let tmpWritten = false
  try {
    // Why: 0o700 — match the file's owner-only policy so the directory does
    // not leak the existence of this Orca/relay install to other local users.
    mkdirSync(endpointDir, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      // Why: mkdirSync's mode only applies on creation — a pre-existing
      // directory keeps its original perms. POSIX-only chmod fix.
      try {
        chmodSync(endpointDir, 0o700)
      } catch {
        // best-effort
      }
    }
    // Why: sweep stale `.endpoint-*.tmp` orphans older than 5 min so a crash
    // between writeFileSync and renameSync cannot grow the dir unboundedly.
    try {
      const entries = readdirSync(endpointDir)
      const cutoff = Date.now() - 5 * 60 * 1000
      for (const entry of entries) {
        if (!entry.startsWith('.endpoint-') || !entry.endsWith('.tmp')) {
          continue
        }
        const entryPath = join(endpointDir, entry)
        try {
          if (statSync(entryPath).mtimeMs < cutoff) {
            unlinkSync(entryPath)
          }
        } catch {
          // best-effort sweep
        }
      }
    } catch {
      // readdirSync can fail on exotic filesystems
    }
    const separator = process.platform === 'win32' ? '\r\n' : '\n'
    writeFileSync(tmpPath, lines.join(separator), { mode: 0o600 })
    tmpWritten = true
    renameSync(tmpPath, finalPath)
    return true
  } catch (err) {
    console.error('[agent-hooks] failed to write endpoint file:', err)
    if (tmpWritten) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // tmp may already be gone
      }
    }
    return false
  }
}

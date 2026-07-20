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
import type { IncomingMessage } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
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
} from 'node:fs'
import { isAbsolute, join } from 'node:path'

import {
  normalizeAgentStatusPayload,
  parseAgentStatusPayload,
  type AgentStatusState,
  type AgentSubagentSnapshot,
  type ParsedAgentStatusPayload
} from './agent-status-types'
import { isAskUserQuestionTool } from './agent-question-answered-intent'
import {
  claudeRosterHasWorkingSubagent,
  claudeRosterToSnapshots,
  claudeTeammateIdMatchesName,
  finishClaudeSubagent,
  foldClaudeBackgroundTasksIntoRoster,
  readClaudeBackgroundAgentTasks,
  removeClaudeTeammateByName,
  upsertWorkingClaudeSubagent,
  type ClaudeSubagentRoster
} from './claude-subagent-roster'
import { ORCA_HOOK_PROTOCOL_VERSION } from './agent-hook-types'
import { REMOTE_AGENT_HOOK_ENV, type AgentHookSource } from './agent-hook-relay'
import {
  extractAgentProviderSession,
  type AgentProviderSessionMetadata
} from './agent-session-resume'
import { parsePaneKey } from './stable-pane-id'
import { isKnownHarnessInjectedUserTurnText } from './harness-injected-user-turns'
import {
  buildGrokChatHistoryPathCandidates,
  findGrokChatHistoryBySessionId,
  getCachedGrokChatHistoryBySessionId,
  GROK_SESSION_ID_MAX_LENGTH,
  isSafeGrokSessionId,
  resolveGrokChatHistoryPathSync,
  resolveGrokSessionsDir
} from './grok-session-paths'

/** Maximum request body size accepted by the listener (1 MB). */
export const HOOK_REQUEST_MAX_BYTES = 1_000_000

/** Bound the warn-once Sets so a buggy/malicious local client that varies its
 *  `version` / `env` fields per request cannot grow them without bound for the
 *  process lifetime. */
const MAX_WARNED_KEYS = 32

/** Slowloris cap: drop requests that have not finished sending after 5 s. */
export const HOOK_REQUEST_SLOWLORIS_MS = 5_000

/** Why: OpenCode plugin builds installed before the throttle/cap fix re-post
 *  the full accumulated reply text on every streamed part update (O(n²) bytes
 *  per turn). Capping at ingest bounds the per-event cost of the status
 *  compare, IPC fanout, renderer store update, and disk persist regardless of
 *  which plugin version is running inside the OpenCode process. */
export const OPENCODE_HOOK_TEXT_MAX_CHARS = 8_000

function capOpenCodeHookText(text: string): string {
  return text.length > OPENCODE_HOOK_TEXT_MAX_CHARS
    ? text.slice(0, OPENCODE_HOOK_TEXT_MAX_CHARS)
    : text
}

/** Bound paneKey size — `${tabId}:${leafUuid}` is well under 200 chars in
 *  practice; cap defends per-pane caches against pathological input.
 *  Exported so non-HTTP ingest paths (e.g. Orca's `ingestRemote`) can apply
 *  the same cap as defense-in-depth. */
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
  antigravityCompletedTranscriptByPaneKey: Map<string, string>
  ampCompletedCacheKeys: Set<string>
  /** Live subagents/teammates per Claude pane. Survives turn boundaries —
   *  background children outlive the lead turn that spawned them. */
  claudeSubagentRosterByPaneKey: Map<string, ClaudeSubagentRoster>
  /** Last state derived from the LEAD session's own events (subagent-origin
   *  events carry `agent_id` and are excluded). Needed so a SubagentStop can
   *  re-emit the pane status without inventing a lead state. `interrupted`
   *  persists here because a gated 'working' emit clamps the flag away, and
   *  the eventual done (when the last child drains) must still carry it. */
  claudeLeadStateByPaneKey: Map<string, ClaudeLeadTurnState>
}

export type ClaudeLeadTurnState = {
  state: AgentStatusState
  interrupted?: true
  /** Set when the waiting state was induced by a subagent's PermissionRequest
   *  or AskUserQuestion (those payloads carry `agent_id`). Only that agent's
   *  next tool activity may clear the wait — other children's churn must not
   *  dismiss a pending human-input card. */
  waitingAgentId?: string
  /** The lead state a child-induced wait displaced. Restored when the wait
   *  clears — the lead may have already finished its turn, and inventing
   *  'working' would leave the pane spinning after the roster drains (the
   *  done-gate only ever downgrades done → working, never back). */
  stateBeforeWait?: Pick<ClaudeLeadTurnState, 'state' | 'interrupted'>
}

export function createHookListenerState(): HookListenerState {
  return {
    warnedVersions: new Set(),
    warnedEnvs: new Set(),
    lastPromptByPaneKey: new Map(),
    lastToolByPaneKey: new Map(),
    lastStatusByPaneKey: new Map(),
    antigravityCompletedTranscriptByPaneKey: new Map(),
    ampCompletedCacheKeys: new Set(),
    claudeSubagentRosterByPaneKey: new Map(),
    claudeLeadStateByPaneKey: new Map()
  }
}

export function clearPaneCacheState(state: HookListenerState, paneKey: string): void {
  deletePaneScopedCacheEntry(state.lastPromptByPaneKey, paneKey)
  deletePaneScopedCacheEntry(state.lastToolByPaneKey, paneKey)
  deletePaneScopedCacheEntry(state.lastStatusByPaneKey, paneKey)
  deletePaneScopedCacheEntry(state.antigravityCompletedTranscriptByPaneKey, paneKey)
  deletePaneScopedSetEntry(state.ampCompletedCacheKeys, paneKey)
  state.claudeSubagentRosterByPaneKey.delete(paneKey)
  state.claudeLeadStateByPaneKey.delete(paneKey)
}

function movePaneScopedMapEntries<T>(
  map: Map<string, T>,
  fromPaneKey: string,
  toPaneKey: string
): void {
  for (const [key, value] of Array.from(map.entries())) {
    if (key !== fromPaneKey && !key.startsWith(`${fromPaneKey}\0`)) {
      continue
    }
    map.delete(key)
    map.set(`${toPaneKey}${key.slice(fromPaneKey.length)}`, value)
  }
}

function movePaneScopedSetEntries(set: Set<string>, fromPaneKey: string, toPaneKey: string): void {
  for (const key of Array.from(set)) {
    if (key !== fromPaneKey && !key.startsWith(`${fromPaneKey}\0`)) {
      continue
    }
    set.delete(key)
    set.add(`${toPaneKey}${key.slice(fromPaneKey.length)}`)
  }
}

export function movePaneCacheState(
  state: HookListenerState,
  fromPaneKey: string,
  toPaneKey: string
): void {
  if (fromPaneKey === toPaneKey) {
    return
  }
  movePaneScopedMapEntries(state.lastPromptByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.lastToolByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.lastStatusByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.antigravityCompletedTranscriptByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedSetEntries(state.ampCompletedCacheKeys, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.claudeSubagentRosterByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.claudeLeadStateByPaneKey, fromPaneKey, toPaneKey)
}

function clearPaneTurnCacheState(state: HookListenerState, paneKey: string): void {
  state.lastPromptByPaneKey.delete(paneKey)
  state.lastToolByPaneKey.delete(paneKey)
  state.antigravityCompletedTranscriptByPaneKey.delete(paneKey)
  state.ampCompletedCacheKeys.delete(paneKey)
}

function deletePaneScopedCacheEntry(map: Map<string, unknown>, paneKey: string): void {
  map.delete(paneKey)
  const scopedPrefix = `${paneKey}\0`
  for (const key of map.keys()) {
    if (key.startsWith(scopedPrefix)) {
      map.delete(key)
    }
  }
}

function deletePaneScopedSetEntry(set: Set<string>, paneKey: string): void {
  set.delete(paneKey)
  const scopedPrefix = `${paneKey}\0`
  for (const key of set) {
    if (key.startsWith(scopedPrefix)) {
      set.delete(key)
    }
  }
}

export function clearAllListenerCaches(state: HookListenerState): void {
  state.lastPromptByPaneKey.clear()
  state.lastToolByPaneKey.clear()
  state.lastStatusByPaneKey.clear()
  state.antigravityCompletedTranscriptByPaneKey.clear()
  state.ampCompletedCacheKeys.clear()
  state.warnedVersions.clear()
  state.warnedEnvs.clear()
  state.claudeSubagentRosterByPaneKey.clear()
  state.claudeLeadStateByPaneKey.clear()
}

/** Emit warn-once diagnostics for cross-build (`version`) and dev-vs-prod
 *  (`env`) mismatches. Shared between the local HTTP path
 *  (`normalizeHookPayload`) and the relay-forwarded path
 *  (`AgentHookServer.ingestRemote`) so a remote-sourced event triggers the
 *  same diagnostic noise as a local one. The relay's "remote" marker is a
 *  location tag, not a build env, so it must not look like stale local hooks. */
export function warnOnHookEnvOrVersionMismatch(
  state: HookListenerState,
  fields: { version?: string; env?: string; expectedEnv: string }
): void {
  const { version, env, expectedEnv } = fields
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
  if (env && env !== REMOTE_AGENT_HOOK_ENV && env !== expectedEnv) {
    const key = `${env}->${expectedEnv}`
    if (!state.warnedEnvs.has(key) && state.warnedEnvs.size < MAX_WARNED_KEYS) {
      state.warnedEnvs.add(key)
      console.warn(
        `[agent-hooks] received ${env} hook on ${expectedEnv} server. ` +
          'Likely a stale terminal from another Orca install.'
      )
    }
  }
}

export type AgentHookEventPayload = {
  paneKey: string
  /** Ephemeral Orca launch identity stamped into the PTY env for this process. */
  launchToken?: string
  tabId?: string
  worktreeId?: string
  /** Identifies the SSH connection the event arrived on, or null for local.
   *  Stamped only on the remote-ingest path (Orca's `ingestRemote`); the
   *  HTTP path always sets null because it cannot know which mux a request
   *  came from. See docs/design/agent-status-over-ssh.md §5. */
  connectionId: string | null
  /** True when this hook event carried prompt text directly, instead of using
   *  the listener's cached prompt from an earlier event in the same pane. */
  hasExplicitPrompt?: boolean
  /** Stable per-turn key when a source exposes enough local hook context to
   *  distinguish duplicate hook delivery from a same-text prompt rerun. */
  promptInteractionKey?: string
  /** Raw agent hook event name, used by main-process transition guards. */
  hookEventName?: string
  /** Claude tool-use identifier when the hook source exposes one. */
  toolUseId?: string
  /** Claude agent/subagent identifier when the hook source exposes one. */
  toolAgentId?: string
  /** Agent/subagent type from the source hook payload, when present. */
  toolAgentType?: string
  /** Provider-owned conversation/session id needed to resume a sleeping agent. */
  providerSession?: AgentProviderSessionMetadata
  /** Session identity update with no turn-state transition. The receiver uses
   *  this to refresh durable resume metadata without showing a fake status row. */
  providerSessionOnly?: boolean
  /** True when this event is a relay cache replay rather than a live hook. */
  isReplay?: boolean
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
    const cleanup = (): void => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('close', onClose)
      // Why: detached parser closures release body chunks; keep a neutral
      // error sink so a late IncomingMessage error cannot become unhandled.
      req.on('error', ignoreSettledRequestError)
    }
    const settleResolve = (value: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(value)
    }
    const settleReject = (error: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(error)
    }
    const onData = (chunk: Buffer): void => {
      // Why: check size in bytes (not UTF-16 code units) and stop accumulating
      // after rejection so a malicious client cannot push memory past the cap.
      if (byteLength + chunk.length > HOOK_REQUEST_MAX_BYTES) {
        settleReject(new Error('payload too large'))
        req.destroy()
        return
      }
      byteLength += chunk.length
      chunks.push(chunk)
    }
    const onEnd = (): void => {
      try {
        // Why: decode once via Buffer.concat so multi-byte UTF-8 characters
        // that straddle a chunk boundary are reassembled correctly.
        const body = chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : ''
        const contentType = req.headers['content-type'] ?? ''
        if (typeof contentType === 'string' && contentType.includes('application/json')) {
          settleResolve(body ? JSON.parse(body) : {})
          return
        }
        if (
          typeof contentType === 'string' &&
          contentType.includes('application/x-www-form-urlencoded')
        ) {
          settleResolve(parseFormEncodedBody(body))
          return
        }
        // Why: existing managed scripts POST JSON; updated POSIX scripts POST
        // form-encoded. Default to JSON for unknown content types.
        settleResolve(body ? JSON.parse(body) : {})
      } catch (error) {
        settleReject(error)
      }
    }
    const onError = (err: Error): void => {
      settleReject(err)
    }
    // Why: req.destroy() (called by the slowloris timer) emits 'close' but
    // not 'end'/'error'. Without this handler the promise would never settle
    // and the chunk buffers would be retained for the process lifetime.
    const onClose = (): void => {
      settleReject(new Error('aborted'))
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('close', onClose)
  })
}

function ignoreSettledRequestError(): void {}

// ─── Per-pane field caches + extractors ─────────────────────────────

type ExtractedPromptText = {
  text: string
  source:
    | 'prompt'
    | 'user_prompt'
    | 'userPrompt'
    | 'initial_prompt'
    | 'initialPrompt'
    | 'user_message'
    | 'message'
    | 'role_user_text'
    | null
}

// Joins the `text` of an Anthropic-style content-block array ([{ type: 'text',
// text }, ...]); plain string items are included too. Returns '' when nothing
// textual is present so callers can fall through to the next prompt source.
function contentBlockArrayText(value: unknown[]): string {
  const parts: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      parts.push(item)
      continue
    }
    if (item && typeof item === 'object') {
      const text = (item as Record<string, unknown>).text
      if (typeof text === 'string') {
        parts.push(text)
      }
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

function extractPromptText(hookPayload: Record<string, unknown>): ExtractedPromptText {
  const candidateKeys = [
    'prompt',
    'user_prompt',
    'userPrompt',
    'initial_prompt',
    'initialPrompt',
    'user_message',
    'message'
  ]
  for (const key of candidateKeys) {
    const value = hookPayload[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      // Why: trim so prompts match what readStringField produces elsewhere —
      // surrounding whitespace would otherwise leak into UI and caches.
      return { text: value.trim(), source: key as Exclude<ExtractedPromptText['source'], null> }
    }
    // Why: Kimi Code sends UserPromptSubmit `prompt` as a content-block array
    // ([{ type: 'text', text }]) rather than a string. Extract its text for the
    // genuine prompt keys. `message` stays string-only: it is the ambiguous
    // status/permission field that hasExplicitUserPrompt intentionally distrusts.
    if (key !== 'message' && Array.isArray(value)) {
      const text = contentBlockArrayText(value)
      if (text.length > 0) {
        return { text, source: key as Exclude<ExtractedPromptText['source'], null> }
      }
    }
  }
  // Why: OpenCode's plugin sends MessagePart events with { role, text }. When
  // role === 'user', the text *is* the prompt — surface it even though
  // OpenCode has no UserPromptSubmit-equivalent.
  if (hookPayload.role === 'user' && typeof hookPayload.text === 'string') {
    const trimmed = capOpenCodeHookText(hookPayload.text.trim())
    if (trimmed.length > 0) {
      return { text: trimmed, source: 'role_user_text' }
    }
  }
  return { text: '', source: null }
}

function stripGrokUserQueryWrapper(promptText: string): string {
  const opener = '<user_query>'
  if (!promptText.startsWith(opener)) {
    return promptText
  }
  const closer = '</user_query>'
  const wrappedText = promptText.slice(opener.length)
  const text = wrappedText.endsWith(closer) ? wrappedText.slice(0, -closer.length) : wrappedText
  // Why: Grok emits the submitted prompt wrapped in its internal
  // `<user_query>` envelope; the status cache should hold the user text.
  return text.trim()
}

function resolvePrompt(
  state: HookListenerState,
  paneKey: string,
  promptText: string,
  options?: { resetOnNewTurn?: boolean }
): string {
  // Why: harness-injected turns (task notifications, system reminders) fire
  // UserPromptSubmit but are not the user's ask — keep the cached real prompt
  // instead of surfacing raw machinery tags in status labels. Match only known
  // harness tags: a real prompt pasting a custom `<my-element>` must reset the
  // turn, not be mistaken for machinery and leave the pane on a stale prompt.
  if (isKnownHarnessInjectedUserTurnText(promptText)) {
    return state.lastPromptByPaneKey.get(paneKey) ?? ''
  }
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
  /** Full JSON of an AskUserQuestion tool input, set only on the event that
   *  carries it. Deliberately NOT inherited across events in resolveToolState
   *  so it clears the moment the agent moves to a different tool / state and a
   *  stale prompt can't linger on the emitted payload. */
  interactivePrompt?: string
  hasToolUpdate?: boolean
  hasToolInputField?: boolean
  lastAssistantMessage?: string
  clearLastAssistantMessage?: boolean
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
  // Why: `undefined` can mean "no update" or "explicit input was not
  // previewable"; extractor metadata decides whether stale input is inherited.
  const clearsUnpreviewableInput =
    update.hasToolInputField === true && update.toolInput === undefined
  const clearsUnidentifiedTool =
    update.hasToolUpdate === true &&
    update.toolName === undefined &&
    update.hasToolInputField === true
  const toolName = clearsUnidentifiedTool ? undefined : (update.toolName ?? previous.toolName)
  const toolInput =
    clearsUnpreviewableInput ||
    (update.toolName !== undefined &&
      update.toolName !== previous.toolName &&
      update.toolInput === undefined)
      ? undefined
      : (update.toolInput ?? previous.toolInput)
  const merged: ToolSnapshot = {
    toolName,
    toolInput,
    // Why: do NOT inherit `previous.interactivePrompt`. The prompt is only
    // valid for the single AskUserQuestion event that produced it; carrying it
    // forward would leave a stale live card on the next tool/state change.
    interactivePrompt: update.interactivePrompt,
    lastAssistantMessage: update.clearLastAssistantMessage
      ? undefined
      : (update.lastAssistantMessage ?? previous.lastAssistantMessage)
  }
  state.lastToolByPaneKey.set(paneKey, merged)
  return merged
}

const TOOL_INPUT_KEYS_BY_TOOL: Record<string, readonly string[]> = {
  Read: ['file_path', 'filePath', 'path'],
  Write: ['file_path', 'filePath', 'path'],
  Create: ['file_path', 'filePath', 'path'],
  Edit: ['file_path', 'filePath', 'path'],
  Execute: ['command'],
  MultiEdit: ['file_path', 'filePath', 'path'],
  NotebookEdit: ['file_path', 'filePath', 'path'],
  Bash: ['command'],
  Glob: ['pattern'],
  Grep: ['pattern'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  FetchUrl: ['url'],
  read_file: ['file_path', 'path'],
  write_file: ['file_path', 'path'],
  read_many_files: ['file_path', 'paths', 'path'],
  edit_file: ['file_path', 'path'],
  replace: ['file_path', 'path'],
  run_shell_command: ['command'],
  run_command: ['CommandLine', 'command', 'cmd'],
  glob: ['pattern'],
  search_file_content: ['pattern'],
  web_fetch: ['url'],
  google_web_search: ['query'],
  exec_command: ['cmd', 'command'],
  shell_command: ['cmd', 'command'],
  run_terminal_cmd: ['command'],
  // Why: Grok maps Bash/Edit/Write to snake_case first-party tool names
  // (run_terminal_command, search_replace, …). Without these keys the status
  // row shows a blank toolInput for the bulk of Grok tool turns.
  run_terminal_command: ['command'],
  search_replace: ['file_path', 'path', 'filePath'],
  write_to_file: ['TargetFile', 'path', 'file_path'],
  execute_code: ['code', 'command', 'cmd'],
  apply_patch: ['path', 'file_path'],
  view_image: ['path', 'file_path'],
  AskUser: ['question', 'prompt', 'message'],
  ask_user: ['question', 'prompt', 'message'],
  AskUserQuestion: ['questions', 'question', 'prompt', 'message'],
  ask_user_question: ['questions', 'question', 'prompt', 'message'],
  bash: ['command'],
  powershell: ['command'],
  create: ['path', 'file_path'],
  read: ['path', 'file_path'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  view: ['path', 'file_path'],
  grep: ['pattern'],
  web_search: ['query'],
  fetch_content: ['url'],
  terminal: ['command'],
  patch: ['path', 'file_path'],
  search_files: ['query', 'pattern', 'path'],
  browser_navigate: ['url'],
  browser_click: ['target', 'selector', 'text'],
  browser_type: ['text', 'target', 'selector'],
  session_search: ['query'],
  skill_manage: ['action', 'name', 'file_path'],
  delegate_task: ['task', 'prompt', 'description'],
  view_file: ['AbsolutePath', 'path', 'file_path'],
  replace_file_content: ['TargetFile', 'path', 'file_path'],
  multi_replace_file_content: ['TargetFile', 'path', 'file_path'],
  list_dir: ['DirectoryPath', 'path'],
  find_by_name: ['SearchDirectory', 'Pattern', 'query'],
  grep_search: ['SearchPath', 'Query', 'query', 'pattern'],
  search_web: ['query'],
  read_url_content: ['Url', 'url'],
  manage_task: ['TaskId', 'Action'],
  schedule: ['Prompt', 'DurationSeconds', 'CronExpression'],
  ask_question: ['question', 'questions'],
  ask_permission: ['Action', 'Target', 'Reason'],
  spawn_subagent: ['prompt', 'description', 'subagent_type'],
  open_page: ['url']
}

const FALLBACK_TOOL_INPUT_KEYS = [
  'command',
  'cmd',
  'code',
  'query',
  'pattern',
  'url',
  'path',
  'file_path',
  'filePath',
  'target',
  'selector',
  'text',
  'action',
  'name',
  'description',
  'CommandLine',
  'AbsolutePath',
  'TargetFile',
  'DirectoryPath',
  'SearchPath',
  'Query',
  'Url',
  'Prompt'
] as const

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

function deriveFallbackToolInputPreview(toolInput: unknown): string | undefined {
  if (typeof toolInput === 'string') {
    return toolInput
  }
  if (typeof toolInput !== 'object' || toolInput === null) {
    return undefined
  }
  const record = toolInput as Record<string, unknown>
  for (const key of FALLBACK_TOOL_INPUT_KEYS) {
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

function hasOwnField(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function hasAnyOwnField(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => hasOwnField(record, key))
}

function toolUpdate(
  fields: Pick<ToolSnapshot, 'toolName' | 'toolInput' | 'interactivePrompt'>,
  options?: { hasToolInputField?: boolean }
): ToolSnapshot {
  return {
    ...fields,
    hasToolUpdate: true,
    hasToolInputField: options?.hasToolInputField === true
  }
}

/** Clear the active-tool metadata (name/input/prompt) so a just-failed tool
 *  stops looking in-flight. Why: the compact sidebar prioritizes current-tool
 *  metadata over the failure message, so a completed failed tool must no
 *  longer look active or the error text stays hidden behind the tool name. */
function clearActiveToolFieldsUpdate(): ToolSnapshot {
  return toolUpdate(
    { toolName: undefined, toolInput: undefined, interactivePrompt: undefined },
    { hasToolInputField: true }
  )
}

/** Capture the full AskUserQuestion tool input as a JSON string when the tool
 *  is an AskUserQuestion variant; otherwise undefined so resolveToolState
 *  clears any prior prompt. Kept agent-generic: callers pass whatever raw
 *  tool-input object their hook payload exposed. */
/** Drop the hook envelope keys a plugin merges into its event properties so
 *  the serialized interactive prompt holds only the question structure. */
function stripHookEnvelopeKeys(record: Record<string, unknown>): Record<string, unknown> {
  const { hook_event_name: _h, hookEventName: _he, ...rest } = record
  return rest
}

/** Short, single-line description of a tool call for an approval card (the
 *  command for Bash, the path for file tools, else a clipped JSON preview). */
function summarizeApprovalInput(toolInput: unknown): string {
  if (toolInput && typeof toolInput === 'object') {
    const obj = toolInput as Record<string, unknown>
    const direct = obj.command ?? obj.file_path ?? obj.path ?? obj.url ?? obj.pattern
    if (typeof direct === 'string' && direct.length > 0) {
      return direct.length > 200 ? `${direct.slice(0, 200)}…` : direct
    }
  }
  try {
    const json = JSON.stringify(toolInput) ?? ''
    return json.length > 200 ? `${json.slice(0, 200)}…` : json
  } catch {
    return ''
  }
}

/** Capture a pending interactive prompt as a normalized JSON envelope:
 *  - AskUserQuestion → the raw `{ questions: [...] }` structure (kind inferred
 *    by the client from the `questions` key, kept stable for back-compat).
 *  - any other tool on a PermissionRequest → `{ approval: { tool, summary } }`
 *    so the client can render an Allow/Deny card.
 *  Returns undefined otherwise so resolveToolState clears any prior prompt. */
function deriveInteractivePrompt(
  toolName: string | undefined,
  toolInput: unknown,
  eventName?: unknown
): string | undefined {
  // Why: providers vary event casing; any post-tool event means the question is
  // no longer pending and must not recreate its answered live card.
  const normalizedEventName = normalizeHookEventName(eventName)
  const isPostToolEvent =
    normalizedEventName === 'post_tool_use' || normalizedEventName === 'post_tool_use_failure'
  if (
    isAskUserQuestionTool(toolName) &&
    !isPostToolEvent &&
    toolInput !== undefined &&
    toolInput !== null
  ) {
    try {
      return JSON.stringify(toolInput)
    } catch {
      // Why: defend against circular/unserializable input from a buggy agent —
      // a missing live card is better than throwing in the hook hot path.
      return undefined
    }
  }
  if (eventName === 'PermissionRequest' && typeof toolName === 'string' && toolName.length > 0) {
    try {
      return JSON.stringify({
        approval: { tool: toolName, summary: summarizeApprovalInput(toolInput) }
      })
    } catch {
      return undefined
    }
  }
  return undefined
}

function readFirstString(
  record: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = readString(record, key)
    if (value) {
      return value
    }
  }
  return undefined
}

function parseJsonObjectString(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined
  }
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function extractToolResponseText(toolResponse: unknown): string | undefined {
  if (typeof toolResponse === 'string' && toolResponse.length > 0) {
    return toolResponse
  }
  if (typeof toolResponse !== 'object' || toolResponse === null) {
    return undefined
  }
  const record = toolResponse as Record<string, unknown>
  const directText = readFirstString(record, ['text_result_for_llm', 'textResultForLlm', 'text'])
  if (directText) {
    return directText
  }
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
  return undefined
}

const TRANSCRIPT_CHUNK_BYTES = 64 * 1024
const TRANSCRIPT_MAX_SCAN_BYTES = 4 * 1024 * 1024
const AMP_THREAD_ID_MAX_LENGTH = 256
const AMP_MAX_SCOPED_THREAD_CACHE_KEYS = 32
const GROK_SESSION_CWD_MAX_LENGTH = 4096
const GROK_HOME_ENVELOPE_MAX_LENGTH = 4096

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
  if (record.type === 'assistant.message') {
    const data = record.data
    if (typeof data === 'object' && data !== null) {
      const text = extractAssistantContentText((data as Record<string, unknown>).content)
      if (text) {
        return text
      }
    }
  }
  if (
    record.source === 'MODEL' &&
    record.type === 'PLANNER_RESPONSE' &&
    typeof record.content === 'string' &&
    record.content.trim().length > 0
  ) {
    return record.content
  }
  const nestedMessage = record.message as Record<string, unknown> | undefined
  const role =
    record.role ?? nestedMessage?.role ?? (record.type === 'assistant' ? 'assistant' : undefined)
  if (role !== 'assistant') {
    return undefined
  }
  const content = (nestedMessage ?? record).content
  return extractAssistantContentText(content)
}

function extractAssistantContentText(content: unknown): string | undefined {
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

function extractAntigravityUserRequest(content: string): string | undefined {
  const opener = '<USER_REQUEST>'
  const startIndex = content.indexOf(opener)
  const bodyStartIndex = startIndex === -1 ? -1 : startIndex + opener.length
  const endIndex = bodyStartIndex === -1 ? -1 : content.indexOf('</USER_REQUEST>', bodyStartIndex)
  const text =
    bodyStartIndex === -1 || endIndex === -1 ? content : content.slice(bodyStartIndex, endIndex)
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function extractUserPromptTextFromLine(line: string): string | undefined {
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
  if (
    (record.source === 'USER_EXPLICIT' || record.source === 'USER') &&
    (record.type === 'USER_INPUT' || record.type === 'REQUEST') &&
    typeof record.content === 'string'
  ) {
    return extractAntigravityUserRequest(record.content)
  }
  return undefined
}

function readLastAssistantFromTranscript(transcriptPath: unknown): string | undefined {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    return undefined
  }
  return readLastAssistantFromTranscriptOnce(transcriptPath)
}

function readLastUserPromptFromTranscript(transcriptPath: unknown): string | undefined {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    return undefined
  }
  return readLastTextFromTranscriptOnce(transcriptPath, extractUserPromptTextFromLine)
}

function extractCommandCodeUserPromptFromLine(line: string): string | undefined {
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
  return record.role === 'user' ? extractAssistantContentText(record.content) : undefined
}

function hashInteractionKeyPart(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function readLastCommandCodeUserPromptEntryFromTranscript(
  transcriptPath: unknown
): { text: string; interactionKey: string } | undefined {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    return undefined
  }
  try {
    const stats = statSync(transcriptPath)
    const size = stats.size
    if (size <= 0) {
      return undefined
    }
    const bytesToRead = Math.min(size, TRANSCRIPT_MAX_SCAN_BYTES)
    const position = size - bytesToRead
    const fd = openSync(transcriptPath, 'r')
    try {
      const buffer = Buffer.alloc(bytesToRead)
      let filled = 0
      while (filled < bytesToRead) {
        const n = readSync(fd, buffer, filled, bytesToRead - filled, position + filled)
        if (n === 0) {
          break
        }
        filled += n
      }
      let text = buffer.subarray(0, filled).toString('utf8')
      let textBasePosition = position
      if (position > 0) {
        const firstNewline = text.indexOf('\n')
        textBasePosition += firstNewline + 1
        text = firstNewline === -1 ? '' : text.slice(firstNewline + 1)
      }
      let lastPrompt: string | undefined
      let lastPromptOffset = 0
      for (const { line, byteOffset } of iterateTranscriptLinesWithByteOffsets(text)) {
        const prompt = extractCommandCodeUserPromptFromLine(line.trim())
        if (prompt !== undefined) {
          lastPrompt = prompt
          lastPromptOffset = textBasePosition + byteOffset
        }
      }
      return lastPrompt
        ? {
            text: lastPrompt,
            interactionKey: [
              'command-code-transcript',
              hashInteractionKeyPart(transcriptPath),
              String(lastPromptOffset),
              hashInteractionKeyPart(lastPrompt)
            ].join('-')
          }
        : undefined
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

function* iterateTranscriptLinesWithByteOffsets(
  text: string
): Generator<{ line: string; byteOffset: number }> {
  let lineStart = 0
  let byteOffset = 0

  for (let index = 0; index <= text.length; index++) {
    if (index < text.length && text.charCodeAt(index) !== 10) {
      continue
    }

    const line = text.slice(lineStart, index)
    yield { line, byteOffset }
    byteOffset += Buffer.byteLength(line, 'utf8') + (index < text.length ? 1 : 0)
    lineStart = index + 1
  }
}

function extractCommandCodeAssistantTextFromLine(line: string): string | undefined {
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
  if (record.role !== 'assistant') {
    return undefined
  }
  const content = record.content
  if (typeof content === 'string' && content.trim().length > 0) {
    return content
  }
  if (Array.isArray(content)) {
    const textPart = content.find(
      (part) =>
        typeof part === 'object' &&
        part !== null &&
        (part as Record<string, unknown>).type === 'text' &&
        typeof (part as Record<string, unknown>).text === 'string' &&
        ((part as Record<string, unknown>).text as string).trim().length > 0
    ) as Record<string, unknown> | undefined
    if (typeof textPart?.text === 'string') {
      return textPart.text
    }
  }
  return extractAssistantContentText(content)
}

function readLastCommandCodeAssistantFromTranscript(transcriptPath: unknown): string | undefined {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    return undefined
  }
  return readLastTextFromTranscriptOnce(transcriptPath, extractCommandCodeAssistantTextFromLine)
}

function parseHookBodyPayloadRecord(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null) {
    return null
  }
  const rawPayload = (body as Record<string, unknown>).payload
  const payload =
    typeof rawPayload === 'string'
      ? (() => {
          try {
            return JSON.parse(rawPayload) as unknown
          } catch {
            return null
          }
        })()
      : rawPayload
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : null
}

function readBoundedString(
  record: Record<string, unknown>,
  keys: readonly string[],
  maxLength: number
): string | undefined {
  const value = readFirstString(record, keys)
  return value && value.length <= maxLength ? value : undefined
}

function readGrokHomeEnvelope(record: Record<string, unknown>): string | undefined {
  const value = readBoundedString(record, ['grokHome'], GROK_HOME_ENVELOPE_MAX_LENGTH)
  if (!value || value !== value.trim() || !isAbsolute(value) || hasControlCharacter(value)) {
    return undefined
  }
  return value
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

type GrokSessionMetadata = {
  sessionId: string
  cwd?: string
  sessionsDir: string
}

function readGrokSessionMetadata(
  hookPayload: Record<string, unknown>,
  grokHome?: string
): GrokSessionMetadata | undefined {
  const sessionId = readBoundedString(
    hookPayload,
    ['sessionId', 'session_id'],
    GROK_SESSION_ID_MAX_LENGTH
  )
  if (!sessionId || !isSafeGrokSessionId(sessionId)) {
    return undefined
  }
  const cwd = readBoundedString(
    hookPayload,
    ['cwd', 'workspaceRoot', 'workspace_root'],
    GROK_SESSION_CWD_MAX_LENGTH
  )
  // Why: hook scripts report the effective per-PTY/remote home; old scripts
  // fall back to the listener runtime's Grok home for compatibility.
  const sessionsDir = grokHome
    ? join(grokHome, 'sessions')
    : resolveGrokSessionsDir(process.env, homedir())
  return { sessionId, cwd, sessionsDir }
}

function getGrokChatHistoryPath(
  hookPayload: Record<string, unknown>,
  grokHome?: string
): string | undefined {
  const metadata = readGrokSessionMetadata(hookPayload, grokHome)
  if (!metadata) {
    return undefined
  }
  const resolved = resolveGrokChatHistoryPathSync({
    sessionId: metadata.sessionId,
    cwd: metadata.cwd ?? null,
    sessionsDir: metadata.sessionsDir
  })
  if (resolved) {
    return resolved
  }
  const cached = getCachedGrokChatHistoryBySessionId(metadata.sessionsDir, metadata.sessionId)
  if (cached) {
    return cached
  }
  // Why: hasPendingAgentResultText only needs a plausible on-disk target when
  // the file may not exist yet (SessionEnd can race the last write). Prefer a
  // short-cwd candidate when available; async discovery caches slug groups.
  if (!metadata.cwd) {
    return undefined
  }
  return (
    buildGrokChatHistoryPathCandidates({
      sessionId: metadata.sessionId,
      cwd: metadata.cwd,
      sessionsDir: metadata.sessionsDir
    })[0] ?? undefined
  )
}

function readLastAssistantFromGrokChatHistory(
  hookPayload: Record<string, unknown>,
  grokHome?: string
): string | undefined {
  const chatHistoryPath = getGrokChatHistoryPath(hookPayload, grokHome)
  if (!chatHistoryPath) {
    return undefined
  }
  return readLastAssistantFromTranscriptOnce(chatHistoryPath)
}

export function hasPendingAgentResultText(source: AgentHookSource, body: unknown): boolean {
  const envelope =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null
  const record = parseHookBodyPayloadRecord(body)
  if (!record) {
    return false
  }
  if (hasExplicitLastAssistantResult(record)) {
    return false
  }
  if (source === 'copilot') {
    // Why: Copilot Stop consumes generic `message` as its final assistant text;
    // Grok and Antigravity use that field for status text instead.
    if (hasNonEmptyString(record.message)) {
      return false
    }
    const transcriptPath = record.transcript_path ?? record.transcriptPath
    return typeof transcriptPath === 'string' && transcriptPath.trim().length > 0
  }
  const eventName =
    envelope?.hook_event_name ??
    envelope?.hookEventName ??
    record.hook_event_name ??
    record.hookEventName
  if (source === 'antigravity' && eventName === 'Stop') {
    if (isAntigravityStopStillBusy(record)) {
      return false
    }
    const transcriptPath = record.transcriptPath ?? record.transcript_path
    return typeof transcriptPath === 'string' && transcriptPath.trim().length > 0
  }
  const pendingGrokDiscovery = preparePendingGrokResultDiscovery(source, body)
  if (pendingGrokDiscovery) {
    void pendingGrokDiscovery
    return true
  }
  return false
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function hasExplicitLastAssistantResult(record: Record<string, unknown>): boolean {
  return (
    hasNonEmptyString(record.last_assistant_message) ||
    hasNonEmptyString(record.lastAssistantMessage)
  )
}

/** Start bounded discovery only for a Grok completion that still needs result text. */
export function preparePendingGrokResultDiscovery(
  source: AgentHookSource,
  body: unknown
): Promise<void> | null {
  if (source !== 'grok') {
    return null
  }
  const envelope =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null
  const record = parseHookBodyPayloadRecord(body)
  if (!record || hasExplicitLastAssistantResult(record)) {
    return null
  }
  const eventName =
    envelope?.hook_event_name ??
    envelope?.hookEventName ??
    record.hook_event_name ??
    record.hookEventName
  if (!isGrokEvent(eventName, 'stop', 'session_end')) {
    return null
  }
  const metadata = readGrokSessionMetadata(
    record,
    envelope ? readGrokHomeEnvelope(envelope) : undefined
  )
  if (!metadata) {
    return null
  }
  // Why: the server can await this signal without moving filesystem discovery
  // back into the synchronous hook normalization path.
  return findGrokChatHistoryBySessionId(metadata.sessionsDir, metadata.sessionId).then(
    () => undefined
  )
}

function readLastAssistantFromTranscriptOnce(transcriptPath: string): string | undefined {
  return readLastTextFromTranscriptOnce(transcriptPath, extractAssistantTextFromLine)
}

function readLastTextFromTranscriptOnce(
  transcriptPath: string,
  extractLineText: (line: string) => string | undefined
): string | undefined {
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
          const extracted = findLastExtractedTranscriptLineText(
            completeRegion.toString('utf8'),
            extractLineText
          )
          if (extracted !== undefined) {
            return extracted
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

function findLastExtractedTranscriptLineText(
  text: string,
  extractLineText: (line: string) => string | undefined
): string | undefined {
  let lineEnd = text.length

  for (let index = text.length - 1; index >= -1; index--) {
    if (index >= 0 && text.charCodeAt(index) !== 10) {
      continue
    }

    const line = text.slice(index + 1, lineEnd).trim()
    if (line.length > 0) {
      const extracted = extractLineText(line)
      if (extracted !== undefined) {
        return extracted
      }
    }
    lineEnd = index
  }

  return undefined
}

function extractClaudeToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  const update: ToolSnapshot = {}
  if (eventName === 'PostToolUseFailure') {
    Object.assign(update, clearActiveToolFieldsUpdate())
  } else if (
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse' ||
    eventName === 'PermissionRequest'
  ) {
    const toolName = readString(hookPayload, 'tool_name')
    Object.assign(
      update,
      toolUpdate(
        {
          toolName,
          toolInput: deriveToolInputPreview(toolName, hookPayload.tool_input),
          interactivePrompt: deriveInteractivePrompt(toolName, hookPayload.tool_input, eventName)
        },
        { hasToolInputField: hasOwnField(hookPayload, 'tool_input') }
      )
    )
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
  if (
    eventName === 'PreToolUse' ||
    eventName === 'PermissionRequest' ||
    eventName === 'PostToolUse'
  ) {
    const toolName = readString(hookPayload, 'tool_name') ?? readString(hookPayload, 'name')
    const rawInput = hookPayload.tool_input ?? hookPayload.input ?? hookPayload.arguments
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      deriveToolInputPreview(toolName, hookPayload.input) ??
      deriveToolInputPreview(toolName, hookPayload.arguments)
    return toolUpdate(
      {
        toolName,
        toolInput,
        interactivePrompt: deriveInteractivePrompt(toolName, rawInput, eventName)
      },
      { hasToolInputField: hasAnyOwnField(hookPayload, ['tool_input', 'input', 'arguments']) }
    )
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
  if (
    eventName === 'BeforeTool' ||
    eventName === 'AfterTool' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse'
  ) {
    const toolName = readString(hookPayload, 'tool_name') ?? readString(hookPayload, 'name')
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      deriveToolInputPreview(toolName, hookPayload.args) ??
      deriveToolInputPreview(toolName, hookPayload.input)
    return toolUpdate(
      { toolName, toolInput },
      { hasToolInputField: hasAnyOwnField(hookPayload, ['tool_input', 'args', 'input']) }
    )
  }
  if (eventName === 'AfterAgent') {
    const message = readString(hookPayload, 'prompt_response')
    if (message) {
      return { lastAssistantMessage: message }
    }
  }
  return {}
}

function readAntigravityToolCall(hookPayload: Record<string, unknown>): {
  toolName?: string
  toolInputSource?: unknown
} {
  const toolCall = hookPayload.toolCall
  if (typeof toolCall !== 'object' || toolCall === null) {
    return {}
  }
  const record = toolCall as Record<string, unknown>
  return {
    toolName: readFirstString(record, ['name', 'toolName', 'tool_name']),
    toolInputSource: record.args
  }
}

function extractAntigravityToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (eventName === 'PreToolUse' || eventName === 'PostToolUse') {
    const toolCall = readAntigravityToolCall(hookPayload)
    const toolName = toolCall.toolName
    const toolInput =
      deriveToolInputPreview(toolName, toolCall.toolInputSource) ??
      deriveFallbackToolInputPreview(toolCall.toolInputSource)
    return toolUpdate(
      { toolName, toolInput },
      { hasToolInputField: toolCall.toolInputSource !== undefined }
    )
  }
  if (eventName === 'Stop') {
    if (isAntigravityStopStillBusy(hookPayload)) {
      return {}
    }
    const message =
      readString(hookPayload, 'last_assistant_message') ??
      readLastAssistantFromTranscript(hookPayload.transcriptPath ?? hookPayload.transcript_path)
    if (message) {
      return { lastAssistantMessage: message }
    }
  }
  return {}
}

function extractAmpToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (eventName === 'tool.call' || eventName === 'tool.result') {
    const toolName =
      readString(hookPayload, 'tool') ??
      readString(hookPayload, 'toolName') ??
      readString(hookPayload, 'name')
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.input) ??
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      deriveToolInputPreview(toolName, hookPayload.arguments) ??
      // Why: Amp plugin tools can have arbitrary names, so fall back to the
      // obvious argument fields instead of rendering an empty tool preview.
      deriveFallbackToolInputPreview(hookPayload.input) ??
      deriveFallbackToolInputPreview(hookPayload.tool_input) ??
      deriveFallbackToolInputPreview(hookPayload.arguments)
    const update: ToolSnapshot = toolUpdate(
      { toolName, toolInput },
      { hasToolInputField: hasAnyOwnField(hookPayload, ['input', 'tool_input', 'arguments']) }
    )
    if (eventName === 'tool.result') {
      const responseText =
        readFirstString(hookPayload, ['error', 'output', 'result', 'message']) ??
        extractToolResponseText(hookPayload.output) ??
        extractToolResponseText(hookPayload.result)
      if (responseText) {
        update.lastAssistantMessage = responseText
      }
    }
    return update
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
      return { lastAssistantMessage: capOpenCodeHookText(text) }
    }
  }
  if (eventName === 'AskUserQuestion') {
    // Why: OpenCode posts the question.asked event's `event.properties` as the
    // hook payload (the plugin merges `hook_event_name` into it). The structured
    // input is that object — minus the hook envelope key — or its `tool_input`
    // when wrapped. Capture the full JSON so clients render the live card.
    const toolInputSource = hasOwnField(hookPayload, 'tool_input')
      ? hookPayload.tool_input
      : stripHookEnvelopeKeys(hookPayload)
    return {
      hasToolUpdate: true,
      interactivePrompt: deriveInteractivePrompt('AskUserQuestion', toolInputSource)
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
    const update: ToolSnapshot = {}
    if (eventName === 'postToolUseFailure') {
      Object.assign(update, clearActiveToolFieldsUpdate())
    } else {
      const toolName = readString(hookPayload, 'tool_name')
      const toolInput = deriveToolInputPreview(toolName, hookPayload.tool_input)
      Object.assign(
        update,
        toolUpdate(
          { toolName, toolInput },
          { hasToolInputField: hasOwnField(hookPayload, 'tool_input') }
        )
      )
    }
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
    return toolUpdate(
      { toolName: 'Shell', toolInput: command },
      { hasToolInputField: hasOwnField(hookPayload, 'command') }
    )
  }
  if (eventName === 'beforeMCPExecution') {
    const toolName = readString(hookPayload, 'tool_name') ?? 'MCP'
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      readString(hookPayload, 'command') ??
      readString(hookPayload, 'url')
    return toolUpdate(
      { toolName, toolInput },
      { hasToolInputField: hasAnyOwnField(hookPayload, ['tool_input', 'command', 'url']) }
    )
  }
  if (eventName === 'afterAgentResponse') {
    const text = readString(hookPayload, 'text')
    if (text) {
      return { lastAssistantMessage: text }
    }
  }
  return {}
}

function normalizeCopilotEventName(eventName: unknown): unknown {
  if (typeof eventName !== 'string') {
    return eventName
  }
  const eventMap: Record<string, string> = {
    sessionStart: 'SessionStart',
    sessionEnd: 'SessionEnd',
    userPromptSubmitted: 'UserPromptSubmit',
    userPromptSubmit: 'UserPromptSubmit',
    preToolUse: 'PreToolUse',
    postToolUse: 'PostToolUse',
    postToolUseFailure: 'PostToolUseFailure',
    subagentStart: 'SubagentStart',
    subagentStop: 'SubagentStop',
    preCompact: 'PreCompact',
    agentStop: 'Stop',
    stop: 'Stop',
    errorOccurred: 'ErrorOccurred',
    permissionRequest: 'PermissionRequest',
    notification: 'Notification'
  }
  return eventMap[eventName] ?? eventName
}

function resolveCopilotEventName(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): unknown {
  const explicit =
    eventName ??
    readFirstString(hookPayload, ['hook_event_name', 'hookEventName', 'hook_type', 'hookType'])
  if (explicit) {
    return explicit
  }
  if (readFirstString(hookPayload, ['initial_prompt', 'initialPrompt'])) {
    return 'SessionStart'
  }
  if (readString(hookPayload, 'prompt')) {
    return 'UserPromptSubmit'
  }
  if (readFirstString(hookPayload, ['notification_type', 'notificationType'])) {
    return 'Notification'
  }
  if (
    readFirstString(hookPayload, ['transcript_path', 'transcriptPath', 'stop_reason', 'stopReason'])
  ) {
    return 'Stop'
  }
  if (hookPayload.error || readFirstString(hookPayload, ['error_context', 'errorContext'])) {
    return 'ErrorOccurred'
  }
  if (
    Array.isArray(hookPayload.toolCalls) ||
    readFirstString(hookPayload, ['tool_name', 'toolName', 'name'])
  ) {
    if (
      hookPayload.tool_result ||
      hookPayload.toolResult ||
      hookPayload.tool_response ||
      hookPayload.toolResponse
    ) {
      return 'PostToolUse'
    }
    return 'PreToolUse'
  }
  return eventName
}

function readCopilotToolCall(hookPayload: Record<string, unknown>): {
  toolName?: string
  toolInputSource?: unknown
} {
  const toolCalls = hookPayload.toolCalls
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return {}
  }
  const first = toolCalls[0]
  if (typeof first !== 'object' || first === null) {
    return {}
  }
  const record = first as Record<string, unknown>
  return {
    toolName: readFirstString(record, ['name', 'toolName', 'tool_name']),
    toolInputSource:
      parseJsonObjectString(record.args) ??
      record.args ??
      parseJsonObjectString(record.arguments) ??
      record.arguments
  }
}

function isAskUserTool(toolName: string | undefined): boolean {
  return toolName?.replaceAll(/[^a-z0-9]/gi, '').toLowerCase() === 'askuser'
}

function extractCopilotToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  const update: ToolSnapshot = {}
  if (eventName === 'PostToolUseFailure' || eventName === 'ErrorOccurred') {
    Object.assign(update, clearActiveToolFieldsUpdate())
  } else if (
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse' ||
    eventName === 'PermissionRequest'
  ) {
    const copilotToolCall = readCopilotToolCall(hookPayload)
    const toolName =
      readFirstString(hookPayload, ['tool_name', 'toolName', 'name']) ?? copilotToolCall.toolName
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      deriveToolInputPreview(toolName, hookPayload.toolInput) ??
      deriveToolInputPreview(toolName, hookPayload.toolArgs) ??
      deriveToolInputPreview(toolName, hookPayload.input) ??
      deriveToolInputPreview(toolName, hookPayload.arguments) ??
      deriveToolInputPreview(toolName, copilotToolCall.toolInputSource)
    Object.assign(
      update,
      toolUpdate(
        { toolName, toolInput },
        {
          hasToolInputField:
            hasAnyOwnField(hookPayload, [
              'tool_input',
              'toolInput',
              'toolArgs',
              'input',
              'arguments'
            ]) || copilotToolCall.toolInputSource !== undefined
        }
      )
    )
    if (isAskUserTool(toolName) && toolInput) {
      update.lastAssistantMessage = toolInput
    }
  }
  if (eventName === 'PostToolUse') {
    const responseText =
      extractToolResponseText(hookPayload.tool_result) ??
      extractToolResponseText(hookPayload.toolResult) ??
      extractToolResponseText(hookPayload.tool_response) ??
      extractToolResponseText(hookPayload.toolResponse)
    if (responseText) {
      update.lastAssistantMessage = responseText
    }
  }
  if (eventName === 'PostToolUseFailure' || eventName === 'ErrorOccurred') {
    const errorText =
      extractToolResponseText(hookPayload.tool_result) ??
      extractToolResponseText(hookPayload.toolResult) ??
      extractToolResponseText(hookPayload.tool_response) ??
      extractToolResponseText(hookPayload.toolResponse) ??
      readFirstString(hookPayload, ['error_message', 'errorMessage', 'error', 'message'])
    if (errorText) {
      update.lastAssistantMessage = errorText
    }
  }
  if (eventName === 'Notification') {
    const notificationType = readFirstString(hookPayload, ['notification_type', 'notificationType'])
    if (notificationType === 'permission_prompt' || notificationType === 'elicitation_dialog') {
      const message = readFirstString(hookPayload, ['message', 'body', 'text', 'title'])
      if (message) {
        update.lastAssistantMessage = message
      }
    }
  }
  if (eventName === 'Stop') {
    const direct = readFirstString(hookPayload, [
      'last_assistant_message',
      'lastAssistantMessage',
      'message'
    ])
    if (direct) {
      update.lastAssistantMessage = direct
    } else {
      const lastFromTranscript = readLastAssistantFromTranscript(
        hookPayload.transcript_path ?? hookPayload.transcriptPath
      )
      if (lastFromTranscript) {
        update.lastAssistantMessage = lastFromTranscript
      } else {
        update.clearLastAssistantMessage = true
      }
    }
  }
  return update
}

function extractPiToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>,
  agentKind: 'pi' | 'omp'
): ToolSnapshot {
  if (
    eventName === 'tool_call' ||
    eventName === 'tool_execution_start' ||
    eventName === 'tool_execution_end'
  ) {
    const toolName = readString(hookPayload, 'tool_name')
    const rawToolInput = hookPayload.tool_input
    const toolInput = deriveToolInputPreview(toolName, rawToolInput)
    // Why: OMP shares this extractor. interactivePrompt derivation should
    // only apply to Pi so OMP ask_user_question metadata stays unchanged.
    const interactivePrompt =
      agentKind === 'pi' && (eventName === 'tool_call' || eventName === 'tool_execution_start')
        ? deriveInteractivePrompt(toolName, rawToolInput, eventName)
        : undefined
    return toolUpdate(
      { toolName, toolInput, interactivePrompt },
      { hasToolInputField: hasOwnField(hookPayload, 'tool_input') }
    )
  }
  if (eventName === 'message_end' && hookPayload.role === 'assistant') {
    const text = readString(hookPayload, 'text')
    if (text) {
      return { lastAssistantMessage: text }
    }
  }
  return {}
}

function isDroidPermissionNotification(message: string | undefined): boolean {
  if (!message) {
    return false
  }
  const lower = message.toLowerCase()
  // Why: 'confirm' is excluded — it false-positives on benign messages like
  // "Confirmed configuration loaded" / "task confirmed" that aren't permission prompts.
  return lower.includes('permission') || lower.includes('approve') || lower.includes('approval')
}

function isDroidIdleNotification(message: string | undefined): boolean {
  if (!message) {
    return false
  }
  const lower = message.toLowerCase()
  return lower.includes('waiting for your input') || lower.includes('waiting for input')
}

function isDroidAskUserTool(toolName: string | undefined): boolean {
  if (!toolName) {
    return false
  }
  return toolName.replaceAll(/[^a-z0-9]/gi, '').toLowerCase() === 'askuser'
}

function readDroidToolRiskLevel(hookPayload: Record<string, unknown>): string | undefined {
  const directRisk = readString(hookPayload, 'riskLevel') ?? readString(hookPayload, 'risk_level')
  if (directRisk) {
    return directRisk
  }

  for (const key of ['tool_input', 'input', 'arguments'] as const) {
    const value = hookPayload[key]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue
    }
    const record = value as Record<string, unknown>
    const nestedRisk = readString(record, 'riskLevel') ?? readString(record, 'risk_level')
    if (nestedRisk) {
      return nestedRisk
    }
  }
  return undefined
}

function isDroidHighRiskToolUse(hookPayload: Record<string, unknown>): boolean {
  return readDroidToolRiskLevel(hookPayload)?.trim().toLowerCase() === 'high'
}

function extractDroidToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse' ||
    eventName === 'PermissionRequest'
  ) {
    const toolName = readString(hookPayload, 'tool_name') ?? readString(hookPayload, 'name')
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      deriveToolInputPreview(toolName, hookPayload.input) ??
      deriveToolInputPreview(toolName, hookPayload.arguments)
    const update: ToolSnapshot = toolUpdate(
      { toolName, toolInput },
      { hasToolInputField: hasAnyOwnField(hookPayload, ['tool_input', 'input', 'arguments']) }
    )
    if (eventName === 'PostToolUse') {
      const responseText =
        extractToolResponseText(hookPayload.tool_response) ??
        extractToolResponseText(hookPayload.tool_output)
      if (responseText) {
        update.lastAssistantMessage = responseText
      }
    }
    return update
  }
  if (eventName === 'Stop') {
    const direct = readString(hookPayload, 'last_assistant_message')
    if (direct) {
      return { lastAssistantMessage: direct }
    }
    const fromTranscript = readLastAssistantFromTranscript(hookPayload.transcript_path)
    if (fromTranscript) {
      return { lastAssistantMessage: fromTranscript }
    }
  }
  return {}
}

function extractCommandCodeToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (eventName === 'PreToolUse' || eventName === 'PostToolUse') {
    const toolName =
      readString(hookPayload, 'tool_name') ??
      readString(hookPayload, 'toolName') ??
      readString(hookPayload, 'tool_display_name')
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      deriveFallbackToolInputPreview(hookPayload.tool_input)
    const update: ToolSnapshot = toolUpdate(
      { toolName, toolInput },
      { hasToolInputField: hasOwnField(hookPayload, 'tool_input') }
    )
    if (eventName === 'PostToolUse') {
      const responseText =
        extractToolResponseText(hookPayload.tool_response) ??
        extractToolResponseText(hookPayload.tool_output)
      if (responseText) {
        update.lastAssistantMessage = responseText
      }
    }
    return update
  }
  if (eventName === 'Stop') {
    const direct = readString(hookPayload, 'last_assistant_message')
    if (direct) {
      return { lastAssistantMessage: direct }
    }
    const fromTranscript = readLastCommandCodeAssistantFromTranscript(
      hookPayload.transcript_path ?? hookPayload.transcriptPath
    )
    if (fromTranscript) {
      return { lastAssistantMessage: fromTranscript }
    }
  }
  return {}
}

function normalizeHookEventName(value: unknown): string {
  if (typeof value !== 'string') {
    return ''
  }
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
}

function isGrokEvent(eventName: unknown, ...expected: readonly string[]): boolean {
  const normalized = normalizeHookEventName(eventName)
  return expected.includes(normalized)
}

function extractGrokToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>,
  grokHome?: string
): ToolSnapshot {
  if (isGrokEvent(eventName, 'pre_tool_use', 'post_tool_use', 'post_tool_use_failure')) {
    const update: ToolSnapshot = {}
    if (isGrokEvent(eventName, 'post_tool_use_failure')) {
      Object.assign(update, clearActiveToolFieldsUpdate())
    } else {
      const toolName =
        readString(hookPayload, 'toolName') ??
        readString(hookPayload, 'tool_name') ??
        readString(hookPayload, 'name')
      const rawInput =
        hookPayload.toolInput ??
        hookPayload.tool_input ??
        hookPayload.input ??
        hookPayload.arguments
      const toolInput =
        deriveToolInputPreview(toolName, rawInput) ?? deriveFallbackToolInputPreview(rawInput)
      // Why: Grok's ask_user_question is auto-allowed and arrives as PreToolUse
      // (not PermissionRequest). Capture the full question payload so the live
      // card path can render options instead of only a waiting Notification.
      const interactivePrompt = deriveInteractivePrompt(toolName, rawInput, eventName)
      Object.assign(
        update,
        toolUpdate(
          { toolName, toolInput, interactivePrompt },
          {
            hasToolInputField: hasAnyOwnField(hookPayload, [
              'toolInput',
              'tool_input',
              'input',
              'arguments'
            ])
          }
        )
      )
    }
    if (isGrokEvent(eventName, 'post_tool_use', 'post_tool_use_failure')) {
      const responseText =
        extractToolResponseText(hookPayload.toolResponse) ??
        extractToolResponseText(hookPayload.tool_response) ??
        extractToolResponseText(hookPayload.toolOutput) ??
        extractToolResponseText(hookPayload.tool_output) ??
        readString(hookPayload, 'error') ??
        readString(hookPayload, 'message')
      if (responseText) {
        update.lastAssistantMessage = responseText
      }
    }
    return update
  }
  if (isGrokEvent(eventName, 'stop', 'session_end', 'stop_failure')) {
    const direct =
      readString(hookPayload, 'lastAssistantMessage') ??
      readString(hookPayload, 'last_assistant_message')
    if (direct) {
      return { lastAssistantMessage: direct }
    }
    const fromTranscript = readLastAssistantFromTranscript(
      hookPayload.transcriptPath ?? hookPayload.transcript_path
    )
    if (fromTranscript) {
      return { lastAssistantMessage: fromTranscript }
    }
    const fromChatHistory = readLastAssistantFromGrokChatHistory(hookPayload, grokHome)
    if (fromChatHistory) {
      return { lastAssistantMessage: fromChatHistory }
    }
  }
  return {}
}

function extractHermesToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (
    eventName === 'pre_tool_call' ||
    eventName === 'post_tool_call' ||
    eventName === 'pre_approval_request' ||
    eventName === 'post_approval_response'
  ) {
    const toolName =
      readString(hookPayload, 'tool_name') ??
      readString(hookPayload, 'name') ??
      (eventName === 'pre_approval_request' || eventName === 'post_approval_response'
        ? 'approval'
        : undefined)
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      deriveToolInputPreview(toolName, hookPayload.args) ??
      deriveToolInputPreview(toolName, hookPayload.input) ??
      // Why: Hermes exposes many first-party/plugin tool names. When a new
      // name appears, still show the obvious argument instead of a blank row.
      deriveFallbackToolInputPreview(hookPayload.tool_input) ??
      deriveFallbackToolInputPreview(hookPayload.args) ??
      deriveFallbackToolInputPreview(hookPayload.input) ??
      readString(hookPayload, 'command') ??
      readString(hookPayload, 'description')
    const update: ToolSnapshot = toolUpdate(
      { toolName, toolInput },
      {
        hasToolInputField: hasAnyOwnField(hookPayload, [
          'tool_input',
          'args',
          'input',
          'command',
          'description'
        ])
      }
    )
    if (eventName === 'post_tool_call') {
      const responseText =
        extractToolResponseText(hookPayload.result) ??
        extractToolResponseText(hookPayload.tool_response) ??
        extractToolResponseText(hookPayload.output)
      if (responseText) {
        update.lastAssistantMessage = responseText
      }
    }
    return update
  }
  if (eventName === 'post_llm_call') {
    const message =
      readString(hookPayload, 'last_assistant_message') ??
      readString(hookPayload, 'assistant_response') ??
      readString(hookPayload, 'response_text')
    if (message) {
      return { lastAssistantMessage: message }
    }
  }
  return {}
}

function isGrokPermissionNotification(message: string | undefined): boolean {
  if (!message) {
    return false
  }
  const lower = message.toLowerCase()
  return (
    lower.includes('permission') ||
    lower.includes('approval') ||
    lower.includes('approve') ||
    lower.includes('allow') ||
    lower.includes('confirm') ||
    lower.includes('needs your') ||
    lower.includes('requires your') ||
    lower.includes('feedback') ||
    lower.includes('clarify') ||
    lower.includes('question')
  )
}

function getGrokNotificationType(hookPayload: Record<string, unknown>): string | undefined {
  return (
    readString(hookPayload, 'notificationType') ??
    readString(hookPayload, 'notification_type') ??
    readString(hookPayload, 'type')
  )
}

function isGrokRoutinePermissionPromptNotification(
  notificationType: string | undefined,
  message: string | undefined,
  level: string | undefined
): boolean {
  // Why: Grok emits this info notification before each tool even under
  // bypassPermissions; PreToolUse already captures progress without paging users.
  return (
    isGrokEvent(notificationType, 'permission_prompt') &&
    message?.trim().toLowerCase() === 'tool permission requested' &&
    (!level || level.trim().toLowerCase() === 'info')
  )
}

function isGrokIdleNotification(message: string | undefined): boolean {
  if (!message) {
    return false
  }
  const lower = message.toLowerCase()
  return (
    lower.includes('type your message') ||
    lower.includes('enter send') ||
    lower.includes('shift-tab normal') ||
    lower.includes('ask a side question')
  )
}

function isNewTurnEvent(source: AgentHookSource, eventName: unknown): boolean {
  // Why: exhaustive switch so adding a source to AgentHookSource fails
  // typecheck here instead of silently falling through to `false`.
  switch (source) {
    case 'claude':
    // Why: Kimi Code emits Claude-compatible hook events, so UserPromptSubmit
    // is its new-turn boundary too.
    case 'kimi':
      return eventName === 'UserPromptSubmit'
    case 'codex':
      return eventName === 'SessionStart' || eventName === 'UserPromptSubmit'
    case 'gemini':
      return eventName === 'BeforeAgent'
    case 'antigravity':
      return eventName === 'PreInvocation'
    case 'amp':
      return eventName === 'agent.start'
    case 'opencode':
    case 'mimo-code':
      return false
    case 'cursor':
      return eventName === 'beforeSubmitPrompt' || eventName === 'sessionStart'
    case 'pi':
    case 'omp':
      return eventName === 'before_agent_start'
    case 'droid':
      return eventName === 'UserPromptSubmit'
    case 'command-code':
      return false
    case 'grok':
      return isGrokEvent(eventName, 'user_prompt_submit')
    case 'copilot': {
      const normalizedEventName = normalizeCopilotEventName(eventName)
      return normalizedEventName === 'SessionStart' || normalizedEventName === 'UserPromptSubmit'
    }
    case 'hermes':
      return eventName === 'pre_llm_call' || eventName === 'on_session_start'
    case 'devin':
      // Why: SessionStart is handled by an early return in normalizeDevinEvent
      // (clears turn cache, returns null) so it never reaches this branch.
      // UserPromptSubmit is the real new-turn boundary for Devin.
      return eventName === 'UserPromptSubmit'
  }
}

function hasExplicitUserPrompt(
  source: AgentHookSource,
  eventName: unknown,
  extractedPrompt: ExtractedPromptText,
  resolvedPromptText: string,
  hasTranscriptPromptEvidence = false
): boolean {
  if (
    source === 'command-code' &&
    (eventName === 'PreToolUse' || eventName === 'Stop') &&
    (extractedPrompt.source !== 'message' || hasTranscriptPromptEvidence) &&
    resolvedPromptText.trim().length > 0
  ) {
    // Why: Command Code exposes the submitted prompt through its transcript
    // rather than direct hook fields. Treat the transcript-backed prompt as
    // explicit so hook telemetry covers real Command Code turns.
    return true
  }
  if (
    source === 'antigravity' &&
    isNewTurnEvent(source, eventName) &&
    resolvedPromptText.trim().length > 0
  ) {
    return true
  }
  if (extractedPrompt.source === 'role_user_text') {
    return (source === 'opencode' || source === 'mimo-code') && eventName === 'MessagePart'
  }
  if (extractedPrompt.text.length === 0) {
    return false
  }
  // Why: harness-injected machinery turns are not proof of a user submit —
  // they must not count for prompt-sent telemetry or permission stickiness.
  // Match only known harness tags: a real prompt starting with a custom
  // `<my-element>` is an explicit user turn and must survive interrupt recovery
  // (a false "not explicit" leaves the agent visibly done after Ctrl+C).
  if (isKnownHarnessInjectedUserTurnText(extractedPrompt.text)) {
    return false
  }
  // Why: bare `message` fields often contain permission or status copy. They
  // may update visible status prompts, but they are not proof of user submit.
  if (extractedPrompt.source === 'message') {
    return false
  }
  if (
    extractedPrompt.source === 'user_prompt' ||
    extractedPrompt.source === 'userPrompt' ||
    extractedPrompt.source === 'user_message'
  ) {
    return isNewTurnEvent(source, eventName)
  }
  return isNewTurnEvent(source, eventName)
}

function extractToolFields(
  source: AgentHookSource,
  eventName: unknown,
  hookPayload: Record<string, unknown>,
  options?: { grokHome?: string }
): ToolSnapshot {
  // Why: exhaustive switch so adding a source to AgentHookSource fails
  // typecheck here instead of silently routing through OpenCode's extractor.
  switch (source) {
    case 'claude':
    // Why: Kimi Code uses Claude's tool_name/tool_input payload fields verbatim.
    case 'kimi':
      return extractClaudeToolFields(eventName, hookPayload)
    case 'codex':
      return extractCodexToolFields(eventName, hookPayload)
    case 'gemini':
      return extractGeminiToolFields(eventName, hookPayload)
    case 'antigravity':
      return extractAntigravityToolFields(eventName, hookPayload)
    case 'amp':
      return extractAmpToolFields(eventName, hookPayload)
    case 'opencode':
    case 'mimo-code':
      return extractOpenCodeToolFields(eventName, hookPayload)
    case 'cursor':
      return extractCursorToolFields(eventName, hookPayload)
    case 'pi':
    case 'omp':
      return extractPiToolFields(eventName, hookPayload, source)
    case 'droid':
      return extractDroidToolFields(eventName, hookPayload)
    case 'command-code':
      return extractCommandCodeToolFields(eventName, hookPayload)
    case 'grok':
      return extractGrokToolFields(eventName, hookPayload, options?.grokHome)
    case 'copilot':
      return extractCopilotToolFields(normalizeCopilotEventName(eventName), hookPayload)
    case 'hermes':
      return extractHermesToolFields(eventName, hookPayload)
    case 'devin':
      return extractClaudeToolFields(eventName, hookPayload)
  }
}

function getOrCreateClaudeSubagentRoster(
  state: HookListenerState,
  paneKey: string
): ClaudeSubagentRoster {
  let roster = state.claudeSubagentRosterByPaneKey.get(paneKey)
  if (!roster) {
    roster = new Map()
    state.claudeSubagentRosterByPaneKey.set(paneKey, roster)
  }
  return roster
}

/** SubagentStart/SubagentStop/TeammateIdle don't map to a pane state by
 *  themselves; they update the roster and re-emit the lead's last known state
 *  with the fresh child list so the sidebar reflects spawn/finish immediately
 *  (a background child can outlive the lead turn by minutes with no other
 *  hook traffic). */
function normalizeClaudeSubagentLifecycleEvent(
  state: HookListenerState,
  eventName: 'SubagentStart' | 'SubagentStop' | 'TeammateIdle',
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const roster = getOrCreateClaudeSubagentRoster(state, paneKey)
  if (eventName === 'TeammateIdle') {
    const teammateName = readString(hookPayload, 'teammate_name')
    if (!teammateName) {
      return null
    }
    // Why: idle means not working, and only working children keep a row. This
    // is the fallback finish signal for a named agent whose SubagentStop was
    // lost — its background_tasks entry never stops reading "running".
    removeClaudeTeammateByName(roster, teammateName)
    clearClaudePendingWaitForAgent(state, paneKey, (waitingAgentId) =>
      claudeTeammateIdMatchesName(waitingAgentId, teammateName)
    )
  } else {
    const agentId = readString(hookPayload, 'agent_id')
    if (!agentId) {
      return null
    }
    if (eventName === 'SubagentStart') {
      upsertWorkingClaudeSubagent(
        roster,
        agentId,
        { agentType: readString(hookPayload, 'agent_type') },
        Date.now()
      )
    } else {
      // Why: a finished child (one-shot, workflow lane, or named teammate)
      // leaves the sidebar at once. SubagentStop is the reliable finish
      // signal even for teammate-shaped ids — their background_tasks entries
      // stay "running" forever — and a resumed teammate re-earns its row.
      finishClaudeSubagent(roster, agentId)
      // Why: a blocked child that dies (killed, errored) without another tool
      // event would otherwise pin its permission/question wait on the pane
      // forever — nothing else references that agent again.
      clearClaudePendingWaitForAgent(state, paneKey, (waitingAgentId) => waitingAgentId === agentId)
    }
  }
  return buildClaudeChildDrivenStatusPayload(state, eventName, paneKey, hookPayload)
}

/** Sync the Claude lead-turn record when the SERVER infers an interrupt
 *  outside the hook stream (Ctrl+C with a missed Stop hook). Without this, a
 *  later child lifecycle event would re-emit the stale pre-interrupt lead
 *  state and resurrect a cancelled pane. */
export function markClaudeLeadTurnInterrupted(state: HookListenerState, paneKey: string): void {
  state.claudeLeadStateByPaneKey.set(paneKey, { state: 'done', interrupted: true })
}

/** Rebuild a pane's working roster from a persisted status snapshot. Live
 *  activity confirms a seed after restart; a complete task inventory may reap
 *  an unconfirmed seed whose finish hook arrived while Orca was offline. */
export function seedClaudeSubagentRosterFromSnapshots(
  state: HookListenerState,
  paneKey: string,
  snapshots: readonly AgentSubagentSnapshot[]
): void {
  if (snapshots.length === 0 || state.claudeSubagentRosterByPaneKey.has(paneKey)) {
    return
  }
  const roster = getOrCreateClaudeSubagentRoster(state, paneKey)
  for (const snapshot of snapshots) {
    // Why: the roster only tracks working children now. A persisted idle
    // snapshot (from a build that kept idle rows) is a finished child — drop
    // it so restart doesn't resurrect the stale pile this fix removes.
    if (snapshot.state !== 'working') {
      continue
    }
    roster.set(snapshot.id, {
      startedAt: snapshot.startedAt,
      agentType: snapshot.agentType,
      description: snapshot.description,
      // Why: the seed can be a phantom (child finished while Orca was down,
      // its SubagentStop lost). Let a PRESENT background_tasks list that
      // omits the id remove it instead of gating the pane 'working' forever.
      backgroundTasksAuthoritative: true
    })
  }
}

/** Drop a child-owned waiting state when that child stops/idles, restoring
 *  the lead state the wait displaced. Without a stash (the wait was the
 *  pane's first observed lead event) fall back to 'working' and let the next
 *  lead event resolve it — a transient spinner beats a permanently stuck
 *  card. */
function clearClaudePendingWaitForAgent(
  state: HookListenerState,
  paneKey: string,
  ownsWait: (waitingAgentId: string) => boolean
): void {
  const lead = state.claudeLeadStateByPaneKey.get(paneKey)
  if (lead?.state !== 'waiting' || !lead.waitingAgentId || !ownsWait(lead.waitingAgentId)) {
    return
  }
  state.claudeLeadStateByPaneKey.set(paneKey, lead.stateBeforeWait ?? { state: 'working' })
}

/** Clear an AskUserQuestion wait after the user's answer was typed into the
 *  terminal. Answering emits no hook event, so the caller infers it from the
 *  submit keystroke. Restores the stashed pre-wait lead state (child-induced
 *  question) or falls back to 'working' (lead question), and drops the cached
 *  question card so later child-driven refreshes cannot re-emit the stale
 *  wait. Returns the pane state to emit, gated up to 'working' while children
 *  still run. */
export function clearClaudeAnsweredQuestionWait(
  state: HookListenerState,
  paneKey: string
): Pick<ClaudeLeadTurnState, 'state' | 'interrupted'> {
  const lead = state.claudeLeadStateByPaneKey.get(paneKey)
  const restored =
    lead?.state === 'waiting'
      ? (lead.stateBeforeWait ?? { state: 'working' as const })
      : { state: 'working' as const }
  state.claudeLeadStateByPaneKey.set(paneKey, { ...restored })
  const previousTool = state.lastToolByPaneKey.get(paneKey)
  state.lastToolByPaneKey.set(
    paneKey,
    previousTool?.lastAssistantMessage
      ? { lastAssistantMessage: previousTool.lastAssistantMessage }
      : {}
  )
  const roster = state.claudeSubagentRosterByPaneKey.get(paneKey)
  return restored.state === 'done' && claudeRosterHasWorkingSubagent(roster)
    ? { state: 'working' }
    : restored
}

/** Emit a pane status refresh driven by child activity (lifecycle events and
 *  child-origin tool events): the lead's cached state is re-emitted — gated up
 *  to 'working' while a child works — without touching the lead's tool/prompt
 *  caches, so a live AskUserQuestion card or permission wait survives child
 *  churn. */
function buildClaudeChildDrivenStatusPayload(
  state: HookListenerState,
  eventName: unknown,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  // Why: default 'working' — a spawn is proof of activity even before the
  // lead's first state-bearing event (e.g. Orca restarted mid-session).
  const lead = state.claudeLeadStateByPaneKey.get(paneKey)
  const leadState = lead?.state ?? 'working'
  const roster = state.claudeSubagentRosterByPaneKey.get(paneKey)
  return buildClaudeStatusPayload(state, eventName, '', paneKey, hookPayload, {
    stateName:
      leadState === 'done' && claudeRosterHasWorkingSubagent(roster) ? 'working' : leadState,
    updateToolSnapshot: false,
    interrupted: lead?.interrupted
  })
}

function normalizeClaudeEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (
    eventName === 'SubagentStart' ||
    eventName === 'SubagentStop' ||
    eventName === 'TeammateIdle'
  ) {
    return normalizeClaudeSubagentLifecycleEvent(state, eventName, paneKey, hookPayload)
  }

  // Why: Claude's AskUserQuestion tool is auto-allowed, so it emits PreToolUse
  // (not PermissionRequest) while blocked on a human answer — Claude posts a
  // Notification instead of PermissionRequest, and Orca does not register the
  // Notification hook. Treat that PreToolUse as waiting so the sidebar shows the
  // amber attention state instead of a working spinner that decays to grey while
  // the question sits unanswered. Mirrors normalizeKimiEvent's handling.
  const isAskUserQuestion =
    eventName === 'PreToolUse' && isAskUserQuestionTool(readString(hookPayload, 'tool_name'))
  const stateName =
    eventName === 'UserPromptSubmit' ||
    eventName === 'PostToolUse' ||
    eventName === 'PostToolUseFailure' ||
    (eventName === 'PreToolUse' && !isAskUserQuestion)
      ? 'working'
      : eventName === 'PermissionRequest' || isAskUserQuestion
        ? 'waiting'
        : eventName === 'Stop' || eventName === 'StopFailure'
          ? 'done'
          : null

  if (!stateName) {
    return null
  }

  const eventAgentId = readString(hookPayload, 'agent_id')
  // Why: hook events originating inside a subagent/teammate carry `agent_id`;
  // the lead session's own events don't. Subagent tool activity keeps that
  // child's row live but must not be mistaken for the lead's turn state, and
  // must not overwrite the lead's tool/prompt caches (a live AskUserQuestion
  // card would vanish when a background child ran its next tool). Two
  // exceptions take the full path below: waiting-inducing events (a child's
  // PermissionRequest/AskUserQuestion needs the human's attention on this
  // pane), and the blocked child's own next tool event (approval granted —
  // the wait must clear exactly as it does for the lead).
  const isWaitingInducing = stateName === 'waiting'
  const subagentOriginId =
    !isWaitingInducing &&
    (eventName === 'PreToolUse' ||
      eventName === 'PostToolUse' ||
      eventName === 'PostToolUseFailure')
      ? eventAgentId
      : undefined
  if (eventAgentId && (subagentOriginId || isWaitingInducing)) {
    upsertWorkingClaudeSubagent(
      getOrCreateClaudeSubagentRoster(state, paneKey),
      eventAgentId,
      { agentType: readString(hookPayload, 'agent_type') },
      Date.now()
    )
  }
  if (subagentOriginId) {
    const lead = state.claudeLeadStateByPaneKey.get(paneKey)
    if (lead?.state !== 'waiting' || lead.waitingAgentId !== subagentOriginId) {
      return buildClaudeChildDrivenStatusPayload(state, eventName, paneKey, hookPayload)
    }
    // Why: approval granted — update the tool snapshot exactly as the lead's
    // own next tool event would (dropping the pending card), but restore the
    // lead state the wait displaced instead of adopting this child event as
    // the lead's 'working': the lead may already be done, and the done-gate
    // never upgrades working back to done once the roster drains.
    const restored = lead.stateBeforeWait ?? { state: 'working' as const }
    state.claudeLeadStateByPaneKey.set(paneKey, restored)
    const roster = state.claudeSubagentRosterByPaneKey.get(paneKey)
    return buildClaudeStatusPayload(state, eventName, promptText, paneKey, hookPayload, {
      stateName:
        restored.state === 'done' && claudeRosterHasWorkingSubagent(roster)
          ? 'working'
          : restored.state,
      updateToolSnapshot: true,
      interrupted: restored.interrupted
    })
  }

  // Why: lead events never carry agent_id, so a known child's id on a
  // turn-boundary event (a CLI that stops converting child Stops to
  // SubagentStop) must not retire or resurrect the pane as if the lead
  // spoke — re-emit it as child activity instead.
  if (
    eventAgentId &&
    !isWaitingInducing &&
    state.claudeSubagentRosterByPaneKey.get(paneKey)?.has(eventAgentId)
  ) {
    return buildClaudeChildDrivenStatusPayload(state, eventName, paneKey, hookPayload)
  }

  if (eventName === 'Stop' || eventName === 'StopFailure') {
    // Why: background_tasks is only trusted where unambiguous (empty list,
    // id-exact matches, unmatched running one-shot subagents) — see
    // foldClaudeBackgroundTasksIntoRoster. The lifecycle events own teammate
    // state; teammates report "running" here even while idle. Older Claude
    // builds without the field keep the incrementally tracked roster.
    const backgroundTasks = readClaudeBackgroundAgentTasks(hookPayload)
    if (backgroundTasks.present) {
      foldClaudeBackgroundTasksIntoRoster(
        getOrCreateClaudeSubagentRoster(state, paneKey),
        backgroundTasks.tasks,
        Date.now(),
        { inventoryComplete: !backgroundTasks.truncated }
      )
    }
  }
  const interrupted =
    eventName === 'Stop' && hookPayload['is_interrupt'] === true ? true : undefined
  // Why: a child-induced wait displaces the lead's own state; stash it so
  // clearing the wait restores reality (the lead may already be done). A
  // second child wait carries the ORIGINAL stash forward, not the
  // intermediate waiting state.
  const previousLead = state.claudeLeadStateByPaneKey.get(paneKey)
  const stateBeforeWait =
    isWaitingInducing && eventAgentId && previousLead
      ? previousLead.state === 'waiting'
        ? previousLead.stateBeforeWait
        : {
            state: previousLead.state,
            ...(previousLead.interrupted ? { interrupted: true as const } : {})
          }
      : undefined
  state.claudeLeadStateByPaneKey.set(paneKey, {
    state: stateName,
    ...(interrupted ? { interrupted } : {}),
    ...(isWaitingInducing && eventAgentId ? { waitingAgentId: eventAgentId } : {}),
    ...(stateBeforeWait ? { stateBeforeWait } : {})
  })

  // Why: the lead ending its turn is not "done" while spawned subagents or
  // teammates are still running — that reads as a finished ✅ in the sidebar
  // while a background review loop is mid-flight. Claude wakes the lead when
  // a child finishes, so a later Stop with an empty roster resolves to done.
  const roster = state.claudeSubagentRosterByPaneKey.get(paneKey)
  const effectiveState =
    stateName === 'done' && claudeRosterHasWorkingSubagent(roster) ? 'working' : stateName

  return buildClaudeStatusPayload(state, eventName, promptText, paneKey, hookPayload, {
    stateName: effectiveState,
    updateToolSnapshot: true,
    interrupted
  })
}

function buildClaudeStatusPayload(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  options: { stateName: AgentStatusState; updateToolSnapshot: boolean; interrupted?: boolean }
): ParsedAgentStatusPayload | null {
  // Why: child-driven refreshes are roster bookkeeping, not lead tool
  // activity. Read the cached tool snapshot without merging so they can't
  // clear a live AskUserQuestion card or clobber the in-flight tool preview.
  const snapshot = options.updateToolSnapshot
    ? resolveToolState(state, paneKey, extractToolFields('claude', eventName, hookPayload), {
        resetOnNewTurn: isNewTurnEvent('claude', eventName)
      })
    : (state.lastToolByPaneKey.get(paneKey) ?? {})

  // Why: normalizeAgentStatusPayload validates the object directly — the
  // JSON stringify/parse round trip the other normalizers use is pure
  // overhead on this hot per-hook-event path. The normalizer clamps
  // `interrupted` to done-state payloads, so a gated 'working' emit drops it
  // while claudeLeadStateByPaneKey preserves it for the eventual done.
  return normalizeAgentStatusPayload({
    state: options.stateName,
    // Why: only lead-origin events (updateToolSnapshot) may reset the prompt
    // cache; a child-driven refresh must not blank the lead's prompt label.
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: options.updateToolSnapshot && isNewTurnEvent('claude', eventName)
    }),
    agentType: 'claude',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    interrupted: options.interrupted,
    subagents: claudeRosterToSnapshots(state.claudeSubagentRosterByPaneKey.get(paneKey))
  })
}

// Why: Devin uses Claude-compatible hook payload shapes but has its own
// documented lifecycle event set. Keep attribution as Devin while normalizing
// those event names into Orca's shared status states.
function normalizeDevinEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (eventName === 'SessionStart') {
    // Why: Devin emits SessionStart when the TUI opens/resumes while still idle.
    // Only UserPromptSubmit or tool activity should create a visible working row —
    // mapping SessionStart to 'working' made the sidebar show "Devin - Running"
    // with a spinner before the user typed anything.
    clearPaneTurnCacheState(state, paneKey)
    return null
  }

  const stateName =
    eventName === 'UserPromptSubmit' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse' ||
    eventName === 'PostCompaction'
      ? 'working'
      : eventName === 'PermissionRequest'
        ? 'waiting'
        : eventName === 'Stop' || eventName === 'SessionEnd'
          ? 'done'
          : null

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('devin', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('devin', eventName) }
  )

  const interrupted =
    eventName === 'Stop' && hookPayload['is_interrupt'] === true ? true : undefined

  return parseAgentStatusPayload(
    JSON.stringify({
      state: stateName,
      prompt: resolvePrompt(state, paneKey, promptText, {
        resetOnNewTurn: isNewTurnEvent('devin', eventName)
      }),
      agentType: 'devin',
      toolName: snapshot.toolName,
      toolInput: snapshot.toolInput,
      interactivePrompt: snapshot.interactivePrompt,
      lastAssistantMessage: snapshot.lastAssistantMessage,
      interrupted
    })
  )
}

// Why: Kimi's AskUserQuestion tool is auto-allowed, so it emits PreToolUse
// instead of PermissionRequest while blocked on a human answer. Treat it as a
// waiting state so the UI shows the attention icon instead of the working spinner.
function isKimiUserInputTool(toolName: string | undefined): boolean {
  return toolName?.replaceAll(/[^a-z0-9]/gi, '').toLowerCase() === 'askuserquestion'
}

// Why: Kimi Code emits Claude-compatible hook payloads and reuses Claude's
// lifecycle event names (UserPromptSubmit/PreToolUse/Stop/...). Normalize them
// into Orca's shared status states while attributing the status to Kimi so the
// sidebar shows the Kimi icon and label instead of falling back to Claude.
function normalizeKimiEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const toolName = readString(hookPayload, 'tool_name')
  const isUserInputTool = isKimiUserInputTool(toolName)

  let stateName: 'working' | 'waiting' | 'done' | null = null
  if (
    eventName === 'UserPromptSubmit' ||
    eventName === 'PostToolUse' ||
    eventName === 'PostToolUseFailure' ||
    (eventName === 'PreToolUse' && !isUserInputTool)
  ) {
    stateName = 'working'
  } else if (eventName === 'PermissionRequest' || (eventName === 'PreToolUse' && isUserInputTool)) {
    stateName = 'waiting'
  } else if (eventName === 'Stop' || eventName === 'StopFailure') {
    stateName = 'done'
  }

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('kimi', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('kimi', eventName) }
  )

  const interrupted =
    eventName === 'Stop' && hookPayload['is_interrupt'] === true ? true : undefined

  return parseAgentStatusPayload(
    JSON.stringify({
      state: stateName,
      prompt: resolvePrompt(state, paneKey, promptText, {
        resetOnNewTurn: isNewTurnEvent('kimi', eventName)
      }),
      agentType: 'kimi',
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
  // Why: Gemini CLI's native pre-tool event is BeforeTool. PreToolUse/PostToolUse
  // remain accepted for legacy Antigravity-compatible payloads on this endpoint.
  const stateName =
    eventName === 'BeforeAgent' ||
    eventName === 'BeforeTool' ||
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
      interactivePrompt: snapshot.interactivePrompt,
      lastAssistantMessage: snapshot.lastAssistantMessage
    })
  )
}

function isAntigravityFeedbackTool(toolName: string | undefined): boolean {
  return toolName === 'ask_question' || toolName === 'ask_permission'
}

function isAntigravityStopStillBusy(hookPayload: Record<string, unknown>): boolean {
  return hookPayload.fullyIdle === false || hookPayload.fully_idle === false
}

function normalizeAntigravityEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const transcriptPath = readFirstString(hookPayload, ['transcriptPath', 'transcript_path'])
  if (eventName === 'PreInvocation') {
    state.antigravityCompletedTranscriptByPaneKey.delete(paneKey)
  } else if (
    transcriptPath &&
    eventName !== 'Stop' &&
    state.antigravityCompletedTranscriptByPaneKey.get(paneKey) === transcriptPath
  ) {
    // Why: agy can emit a bookkeeping PostToolUse after Stop; ignore it so a
    // finished row does not turn back into a yellow spinner.
    return null
  }

  const toolName = readAntigravityToolCall(hookPayload).toolName
  const stopStillBusy = eventName === 'Stop' && isAntigravityStopStillBusy(hookPayload)
  const stateName =
    eventName === 'PreToolUse' && isAntigravityFeedbackTool(toolName)
      ? 'waiting'
      : eventName === 'Stop'
        ? stopStillBusy
          ? 'working'
          : 'done'
        : eventName === 'PreInvocation' ||
            eventName === 'PostInvocation' ||
            eventName === 'PreToolUse' ||
            eventName === 'PostToolUse'
          ? 'working'
          : null

  if (!stateName) {
    return null
  }

  const resetsTurn = isNewTurnEvent('antigravity', eventName)
  // Why: Antigravity transcripts can grow during long tool-heavy turns. Once
  // the prompt is cached for this pane, avoid rescanning the file per hook.
  const cachedPrompt = resetsTurn ? undefined : state.lastPromptByPaneKey.get(paneKey)
  const effectivePrompt =
    promptText || cachedPrompt || readLastUserPromptFromTranscript(transcriptPath) || ''
  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('antigravity', eventName, hookPayload),
    { resetOnNewTurn: resetsTurn }
  )

  const payload = parseAgentStatusPayload(
    JSON.stringify({
      state: stateName,
      prompt: resolvePrompt(state, paneKey, effectivePrompt, {
        resetOnNewTurn: resetsTurn
      }),
      agentType: 'antigravity',
      toolName: snapshot.toolName,
      toolInput: snapshot.toolInput,
      interactivePrompt: snapshot.interactivePrompt,
      lastAssistantMessage: snapshot.lastAssistantMessage
    })
  )
  // Why: Antigravity can emit Stop with fullyIdle=false between tool steps.
  // Only a fully idle Stop is terminal; otherwise the sidebar would bounce
  // done -> working during tool-heavy turns and ignore later tool updates.
  if (eventName === 'Stop' && !stopStillBusy && transcriptPath) {
    state.antigravityCompletedTranscriptByPaneKey.set(paneKey, transcriptPath)
  }
  return payload
}

function normalizeAmpEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const ampCacheKey = getAmpCacheKey(paneKey, hookPayload)
  if (eventName === 'session.start') {
    clearPaneTurnCacheState(state, ampCacheKey)
    if (ampCacheKey !== paneKey) {
      clearPaneTurnCacheState(state, paneKey)
    }
    return null
  }

  const stateName =
    eventName === 'agent.start' || eventName === 'tool.call' || eventName === 'tool.result'
      ? 'working'
      : eventName === 'agent.end'
        ? 'done'
        : null

  if (!stateName) {
    return null
  }
  if (eventName === 'agent.start') {
    state.ampCompletedCacheKeys.delete(ampCacheKey)
  } else if (
    (eventName === 'tool.call' || eventName === 'tool.result') &&
    state.ampCompletedCacheKeys.has(ampCacheKey)
  ) {
    // Why: Amp status posts are fire-and-forget so tool requests cannot block
    // the agent. Drop stale tool events that arrive after the thread ended.
    return null
  }

  const snapshot = resolveToolState(
    state,
    ampCacheKey,
    extractToolFields('amp', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('amp', eventName) }
  )

  const interrupted =
    eventName === 'agent.end' && hookPayload.status === 'cancelled' ? true : undefined
  const explicitPrompt = readFirstString(hookPayload, [
    'prompt',
    'user_prompt',
    'userPrompt',
    'initial_prompt',
    'initialPrompt',
    'user_message'
  ])
  const canUseMessageAsPrompt =
    eventName === 'agent.start' ||
    (eventName === 'agent.end' && !state.lastPromptByPaneKey.has(ampCacheKey))
  const ampPromptText = explicitPrompt ?? (canUseMessageAsPrompt ? promptText : '')

  const normalized = parseAgentStatusPayload(
    JSON.stringify({
      state: stateName,
      // Why: Amp tool/result events may use `message` for tool output; only
      // lifecycle events may treat it as the turn prompt.
      prompt: resolvePrompt(state, ampCacheKey, ampPromptText, {
        resetOnNewTurn: isNewTurnEvent('amp', eventName)
      }),
      agentType: 'amp',
      toolName: snapshot.toolName,
      toolInput: snapshot.toolInput,
      interactivePrompt: snapshot.interactivePrompt,
      lastAssistantMessage: snapshot.lastAssistantMessage,
      interrupted
    })
  )
  if (normalized && eventName === 'agent.end') {
    state.ampCompletedCacheKeys.add(ampCacheKey)
  }
  if (normalized) {
    pruneAmpThreadCacheKeys(state, paneKey, ampCacheKey)
  }
  return normalized
}

function getAmpCacheKey(paneKey: string, hookPayload: Record<string, unknown>): string {
  const threadId = readBoundedString(
    hookPayload,
    ['threadId', 'threadID', 'thread_id'],
    AMP_THREAD_ID_MAX_LENGTH
  )
  // Why: Amp plugin processes can emit events for multiple threads in one
  // pane. Cache by thread internally while keeping the visible paneKey stable.
  return threadId ? `${paneKey}\0amp:${threadId}` : paneKey
}

function pruneAmpThreadCacheKeys(
  state: HookListenerState,
  paneKey: string,
  currentCacheKey: string
): void {
  const scopedPrefix = `${paneKey}\0amp:`
  if (!currentCacheKey.startsWith(scopedPrefix)) {
    return
  }

  const scopedKeys = new Set<string>()
  for (const key of state.lastPromptByPaneKey.keys()) {
    if (key.startsWith(scopedPrefix)) {
      scopedKeys.add(key)
    }
  }
  for (const key of state.lastToolByPaneKey.keys()) {
    if (key.startsWith(scopedPrefix)) {
      scopedKeys.add(key)
    }
  }
  for (const key of state.ampCompletedCacheKeys) {
    if (key.startsWith(scopedPrefix)) {
      scopedKeys.add(key)
    }
  }

  let overflow = scopedKeys.size - AMP_MAX_SCOPED_THREAD_CACHE_KEYS
  if (overflow <= 0) {
    return
  }

  // Why: Amp can multiplex many thread IDs through one pane. Keep the current
  // thread plus the most recent cache entries instead of retaining every
  // completed thread until pane teardown.
  for (const key of scopedKeys) {
    if (overflow <= 0) {
      break
    }
    if (key === currentCacheKey) {
      continue
    }
    state.lastPromptByPaneKey.delete(key)
    state.lastToolByPaneKey.delete(key)
    state.ampCompletedCacheKeys.delete(key)
    overflow--
  }
}

function hasExplicitPromptForSource(
  source: AgentHookSource,
  eventName: unknown,
  promptText: string,
  hookPayload: Record<string, unknown>
): boolean {
  if (source !== 'amp') {
    return promptText.length > 0
  }
  if (
    readFirstString(hookPayload, [
      'prompt',
      'user_prompt',
      'userPrompt',
      'initial_prompt',
      'initialPrompt',
      'user_message'
    ])
  ) {
    return true
  }
  // Why: Amp tool/result `message` is output text, not a user prompt.
  return eventName === 'agent.start' && promptText.length > 0
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
      interactivePrompt: snapshot.interactivePrompt,
      lastAssistantMessage: snapshot.lastAssistantMessage
    })
  )
}

function normalizeOpenCodeFamilyEvent(
  source: 'opencode' | 'mimo-code',
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
    extractToolFields(source, eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent(source, eventName) }
  )

  return parseAgentStatusPayload(
    JSON.stringify({
      state: stateName,
      prompt: resolvePrompt(state, paneKey, promptText, {
        resetOnNewTurn: isNewTurnEvent(source, eventName)
      }),
      agentType: source,
      toolName: snapshot.toolName,
      toolInput: snapshot.toolInput,
      interactivePrompt: snapshot.interactivePrompt,
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
  // Why: Cursor can emit the final response text after `stop`; that should
  // enrich the completed row, not resurrect the agent as working.
  const previousStatus = state.lastStatusByPaneKey.get(paneKey)?.payload
  const stateName =
    eventName === 'beforeSubmitPrompt' ||
    eventName === 'sessionStart' ||
    eventName === 'preToolUse' ||
    eventName === 'postToolUse' ||
    eventName === 'postToolUseFailure' ||
    // Why: these fire for every shell/MCP invocation as pre-execution gates,
    // not only when the user is blocked on approval. Treat them like PreToolUse
    // so a tool-heavy turn does not spam waiting-state notifications.
    eventName === 'beforeShellExecution' ||
    eventName === 'beforeMCPExecution'
      ? 'working'
      : eventName === 'afterAgentResponse'
        ? previousStatus?.state === 'done' && previousStatus.agentType === 'cursor'
          ? 'done'
          : 'working'
        : eventName === 'stop' || eventName === 'sessionEnd'
          ? 'done'
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
      interactivePrompt: snapshot.interactivePrompt,
      lastAssistantMessage: snapshot.lastAssistantMessage,
      interrupted
    })
  )
}

// Why: PermissionRequest fires before Copilot's allow/ask/deny checks, so a
// generic PermissionRequest stays working. `ask_user` itself is a user-input
// boundary, and notification prompts are the async user-visible blocked signal.
function normalizeCopilotEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const normalizedEventName = normalizeCopilotEventName(
    resolveCopilotEventName(eventName, hookPayload)
  )
  const notificationType = readFirstString(hookPayload, ['notification_type', 'notificationType'])
  const isBlockingNotification =
    normalizedEventName === 'Notification' &&
    (notificationType === 'permission_prompt' || notificationType === 'elicitation_dialog')
  const toolSnapshot = extractToolFields('copilot', normalizedEventName, hookPayload)
  const isAskUserPrompt =
    (normalizedEventName === 'PreToolUse' || normalizedEventName === 'PermissionRequest') &&
    isAskUserTool(toolSnapshot.toolName)
  const stateName =
    normalizedEventName === 'SessionStart' ||
    normalizedEventName === 'UserPromptSubmit' ||
    normalizedEventName === 'PostToolUse' ||
    normalizedEventName === 'PostToolUseFailure'
      ? 'working'
      : isBlockingNotification || isAskUserPrompt
        ? 'blocked'
        : normalizedEventName === 'PreToolUse' || normalizedEventName === 'PermissionRequest'
          ? 'working'
          : normalizedEventName === 'Stop' || normalizedEventName === 'SessionEnd'
            ? 'done'
            : normalizedEventName === 'ErrorOccurred'
              ? hookPayload.recoverable === true
                ? 'working'
                : 'done'
              : null

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(state, paneKey, toolSnapshot, {
    resetOnNewTurn: isNewTurnEvent('copilot', normalizedEventName)
  })

  const effectivePrompt = normalizedEventName === 'Notification' ? '' : promptText

  return parseAgentStatusPayload(
    JSON.stringify({
      state: stateName,
      prompt: resolvePrompt(state, paneKey, effectivePrompt, {
        resetOnNewTurn: isNewTurnEvent('copilot', normalizedEventName)
      }),
      agentType: 'copilot',
      toolName: snapshot.toolName,
      toolInput: snapshot.toolInput,
      interactivePrompt: snapshot.interactivePrompt,
      lastAssistantMessage: snapshot.lastAssistantMessage
    })
  )
}

function normalizePiCompatibleEvent(
  state: HookListenerState,
  agentType: 'pi' | 'omp',
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (agentType === 'pi' && eventName === 'session_start') {
    // Why: Pi emits session_start when the TUI opens or resumes; discard stale
    // turn details without creating a visible working row before user activity.
    clearPaneTurnCacheState(state, paneKey)
    return null
  }

  // Why: gate on the event's own tool_name (matching the Claude/Grok normalizers),
  // not a merged snapshot, so a partial follow-up event can't inherit a stale
  // ask_user_question name from the tool cache and spuriously re-enter blocked.
  const isPiAskUserQuestion =
    agentType === 'pi' &&
    isAskUserQuestionTool(readString(hookPayload, 'tool_name')) &&
    (eventName === 'tool_call' || eventName === 'tool_execution_start')

  const stateName = isPiAskUserQuestion
    ? 'blocked'
    : eventName === 'before_agent_start' ||
        eventName === 'agent_start' ||
        eventName === 'tool_call' ||
        eventName === 'tool_execution_start' ||
        eventName === 'tool_execution_end' ||
        eventName === 'message_end'
      ? 'working'
      : eventName === 'agent_end'
        ? 'done'
        : null

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields(agentType, eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent(agentType, eventName) }
  )

  return parseAgentStatusPayload(
    JSON.stringify({
      state: stateName,
      prompt: resolvePrompt(state, paneKey, promptText, {
        resetOnNewTurn: isNewTurnEvent(agentType, eventName)
      }),
      agentType,
      toolName: snapshot.toolName,
      toolInput: snapshot.toolInput,
      interactivePrompt: snapshot.interactivePrompt,
      lastAssistantMessage: snapshot.lastAssistantMessage
    })
  )
}

function normalizeDroidEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (eventName === 'SessionStart') {
    // Why: Droid emits SessionStart when the TUI opens/resumes while still idle.
    // Only UserPromptSubmit or tool activity should create a visible working row.
    clearPaneTurnCacheState(state, paneKey)
    return null
  }

  const notificationMessage = readString(hookPayload, 'message')
  const droidToolName = readString(hookPayload, 'tool_name') ?? readString(hookPayload, 'name')
  let stateName: 'working' | 'waiting' | 'done' | null = null
  if (
    eventName === 'PreToolUse' &&
    (isDroidAskUserTool(droidToolName) || isDroidHighRiskToolUse(hookPayload))
  ) {
    // Why: Droid surfaces both AskUser and high-risk approval prompts as
    // PreToolUse events; the observed approval path emits no Notification hook.
    stateName = 'waiting'
  } else if (
    eventName === 'UserPromptSubmit' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse'
  ) {
    stateName = 'working'
  } else if (eventName === 'Stop') {
    stateName = 'done'
  } else if (eventName === 'PermissionRequest') {
    stateName = 'waiting'
  } else if (eventName === 'Notification' && isDroidPermissionNotification(notificationMessage)) {
    stateName = 'waiting'
  } else if (eventName === 'Notification' && isDroidIdleNotification(notificationMessage)) {
    // Why: Factory does not emit Stop when the user interrupts Droid, but it
    // does emit an idle notification when Droid is ready for input again.
    stateName = 'done'
  }
  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('droid', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('droid', eventName) }
  )

  // Why: Droid's Notification.message contains status text (e.g. "Droid is
  // waiting for your input"), not the user's prompt. Pass '' so resolvePrompt
  // falls back to the cached UserPromptSubmit value instead of overwriting it.
  const effectivePrompt = eventName === 'Notification' ? '' : promptText

  return parseAgentStatusPayload(
    JSON.stringify({
      state: stateName,
      prompt: resolvePrompt(state, paneKey, effectivePrompt, {
        resetOnNewTurn: isNewTurnEvent('droid', eventName)
      }),
      agentType: 'droid',
      toolName: snapshot.toolName,
      toolInput: snapshot.toolInput,
      interactivePrompt: snapshot.interactivePrompt,
      lastAssistantMessage: snapshot.lastAssistantMessage
    })
  )
}

function normalizeCommandCodeEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const stateName =
    eventName === 'PreToolUse' || eventName === 'PostToolUse'
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
    extractToolFields('command-code', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('command-code', eventName) }
  )

  return parseAgentStatusPayload(
    JSON.stringify({
      state: stateName,
      prompt: resolvePrompt(state, paneKey, promptText, {
        resetOnNewTurn: isNewTurnEvent('command-code', eventName)
      }),
      agentType: 'command-code',
      toolName: snapshot.toolName,
      toolInput: snapshot.toolInput,
      interactivePrompt: snapshot.interactivePrompt,
      lastAssistantMessage: snapshot.lastAssistantMessage
    })
  )
}

function normalizeGrokEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  grokHome?: string
): ParsedAgentStatusPayload | null {
  if (isGrokEvent(eventName, 'session_start')) {
    // Why: Grok emits SessionStart when the TUI opens/resumes. It should reset
    // stale per-turn details without creating a visible "working" row before a
    // user prompt or tool event exists.
    clearPaneTurnCacheState(state, paneKey)
    return null
  }

  const notificationMessage = readString(hookPayload, 'message')
  const notificationType = getGrokNotificationType(hookPayload)
  const notificationLevel = readString(hookPayload, 'level')
  const preToolName =
    readString(hookPayload, 'toolName') ??
    readString(hookPayload, 'tool_name') ??
    readString(hookPayload, 'name')
  // Why: Grok's ask_user_question is auto-allowed, so it emits PreToolUse while
  // blocked on a human answer (same shape as Kimi). Map that to waiting so the
  // sidebar attention state matches Claude PermissionRequest UX.
  const isUserInputPreTool =
    isGrokEvent(eventName, 'pre_tool_use') && isAskUserQuestionTool(preToolName)

  let stateName: 'working' | 'waiting' | 'done' | null = null
  if (
    isGrokEvent(eventName, 'user_prompt_submit', 'post_tool_use', 'post_tool_use_failure') ||
    (isGrokEvent(eventName, 'pre_tool_use') && !isUserInputPreTool)
  ) {
    stateName = 'working'
  } else if (isUserInputPreTool) {
    stateName = 'waiting'
  } else if (isGrokEvent(eventName, 'stop', 'session_end', 'stop_failure')) {
    stateName = 'done'
  } else if (
    isGrokEvent(eventName, 'notification') &&
    isGrokRoutinePermissionPromptNotification(
      notificationType,
      notificationMessage,
      notificationLevel
    )
  ) {
    return null
  } else if (
    isGrokEvent(eventName, 'notification') &&
    isGrokPermissionNotification(notificationMessage)
  ) {
    stateName = 'waiting'
  } else if (
    isGrokEvent(eventName, 'notification') &&
    isGrokIdleNotification(notificationMessage)
  ) {
    stateName = 'done'
  }
  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('grok', eventName, hookPayload, { grokHome }),
    { resetOnNewTurn: isNewTurnEvent('grok', eventName) }
  )

  // Why: Grok Notification.message is status UI text, not necessarily the
  // user's prompt. Preserve the cached UserPromptSubmit prompt for the row.
  const effectivePrompt = isGrokEvent(eventName, 'notification')
    ? ''
    : stripGrokUserQueryWrapper(promptText)

  return parseAgentStatusPayload(
    JSON.stringify({
      state: stateName,
      prompt: resolvePrompt(state, paneKey, effectivePrompt, {
        resetOnNewTurn: isNewTurnEvent('grok', eventName)
      }),
      agentType: 'grok',
      toolName: snapshot.toolName,
      toolInput: snapshot.toolInput,
      interactivePrompt: snapshot.interactivePrompt,
      lastAssistantMessage: snapshot.lastAssistantMessage
    })
  )
}

function normalizeHermesEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const stateName =
    eventName === 'pre_approval_request'
      ? 'waiting'
      : eventName === 'post_llm_call' ||
          eventName === 'on_session_end' ||
          eventName === 'on_session_finalize' ||
          eventName === 'on_session_reset'
        ? 'done'
        : eventName === 'on_session_start' ||
            eventName === 'pre_llm_call' ||
            eventName === 'pre_tool_call' ||
            eventName === 'post_tool_call' ||
            eventName === 'post_approval_response'
          ? 'working'
          : null

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('hermes', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('hermes', eventName) }
  )

  return parseAgentStatusPayload(
    JSON.stringify({
      state: stateName,
      prompt: resolvePrompt(state, paneKey, promptText, {
        resetOnNewTurn: isNewTurnEvent('hermes', eventName)
      }),
      agentType: 'hermes',
      toolName: snapshot.toolName,
      toolInput: snapshot.toolInput,
      interactivePrompt: snapshot.interactivePrompt,
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
  const parsedPaneKey = parsePaneKey(paneKey)
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
    !parsedPaneKey ||
    typeof hookPayload !== 'object' ||
    hookPayload === null
  ) {
    return null
  }

  warnOnHookEnvOrVersionMismatch(state, {
    version: readStringField(record, 'version'),
    env: readStringField(record, 'env'),
    expectedEnv
  })

  const tabId = readStringField(record, 'tabId')
  if (tabId && tabId !== parsedPaneKey.tabId) {
    return null
  }
  const worktreeId = readStringField(record, 'worktreeId')
  const launchToken = readStringField(record, 'launchToken')

  const hookPayloadRecord = hookPayload as Record<string, unknown>
  let promptInteractionKey: string | undefined
  const eventName =
    readFirstString(record, ['hook_event_name', 'hookEventName', 'hook_type', 'hookType']) ??
    hookPayloadRecord.hook_event_name ??
    hookPayloadRecord.hookEventName
  const extractedPrompt = extractPromptText(hookPayload as Record<string, unknown>)
  const promptText = extractedPrompt.text
  let resolvedPromptText = promptText
  let hasTranscriptPromptEvidence = false
  // Why: exhaustive switch so adding a source to AgentHookSource fails
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
    case 'antigravity':
      if (isNewTurnEvent('antigravity', eventName)) {
        resolvedPromptText =
          promptText ||
          readLastUserPromptFromTranscript(
            readFirstString(hookPayloadRecord, ['transcriptPath', 'transcript_path'])
          ) ||
          ''
      }
      payload = normalizeAntigravityEvent(state, eventName, promptText, paneKey, hookPayloadRecord)
      break
    case 'amp':
      payload = normalizeAmpEvent(state, eventName, promptText, paneKey, hookPayloadRecord)
      break
    case 'opencode':
    case 'mimo-code':
      if (extractedPrompt.source === 'role_user_text') {
        const messageId = readFirstString(hookPayloadRecord, [
          'messageID',
          'messageId',
          'message_id'
        ])
        const prefix = source === 'mimo-code' ? 'mimo-code-message' : 'opencode-message'
        promptInteractionKey = messageId ? `${prefix}-${messageId}` : undefined
      }
      payload = normalizeOpenCodeFamilyEvent(
        source,
        state,
        eventName,
        promptText,
        paneKey,
        hookPayloadRecord
      )
      break
    case 'cursor':
      payload = normalizeCursorEvent(state, eventName, promptText, paneKey, hookPayloadRecord)
      break
    case 'pi':
      payload = normalizePiCompatibleEvent(
        state,
        'pi',
        eventName,
        promptText,
        paneKey,
        hookPayloadRecord
      )
      break
    case 'omp':
      payload = normalizePiCompatibleEvent(
        state,
        'omp',
        eventName,
        promptText,
        paneKey,
        hookPayloadRecord
      )
      break
    case 'droid':
      payload = normalizeDroidEvent(state, eventName, promptText, paneKey, hookPayloadRecord)
      break
    case 'command-code':
      {
        const transcriptPrompt = readLastCommandCodeUserPromptEntryFromTranscript(
          hookPayloadRecord.transcript_path ?? hookPayloadRecord.transcriptPath
        )
        hasTranscriptPromptEvidence = transcriptPrompt !== undefined
        promptInteractionKey = transcriptPrompt?.interactionKey
        resolvedPromptText = transcriptPrompt?.text ?? ''
        if (promptText && extractedPrompt.source !== 'message') {
          resolvedPromptText = promptText
        }
      }
      payload = normalizeCommandCodeEvent(
        state,
        eventName,
        resolvedPromptText,
        paneKey,
        hookPayloadRecord
      )
      break
    case 'grok':
      payload = normalizeGrokEvent(
        state,
        eventName,
        promptText,
        paneKey,
        hookPayloadRecord,
        readGrokHomeEnvelope(record)
      )
      break
    case 'copilot':
      payload = normalizeCopilotEvent(state, eventName, promptText, paneKey, hookPayloadRecord)
      break
    case 'hermes':
      payload = normalizeHermesEvent(state, eventName, promptText, paneKey, hookPayloadRecord)
      break
    case 'devin':
      payload = normalizeDevinEvent(state, eventName, promptText, paneKey, hookPayloadRecord)
      break
    case 'kimi':
      payload = normalizeKimiEvent(state, eventName, promptText, paneKey, hookPayloadRecord)
      break
  }

  // Why: connectionId stays null at the listener layer. The local server keeps
  // it null; the relay forwards null on the wire and Orca's `ingestRemote`
  // stamps the real value from `mux` identity on receive. See
  // docs/design/agent-status-over-ssh.md §5.
  const providerSession = extractAgentProviderSession(source, hookPayloadRecord)
  const providerSessionOnly =
    source === 'pi' && eventName === 'session_start' && providerSession !== null
  // Why: session_start establishes resume identity while Pi is idle. Carry a
  // valid placeholder through the status-shaped transport; receivers discard
  // it when providerSessionOnly is set, so no working/done row is fabricated.
  const transportPayload =
    payload ??
    (providerSessionOnly
      ? normalizeAgentStatusPayload({ state: 'done', prompt: '', agentType: 'pi' })
      : null)
  return transportPayload
    ? {
        paneKey,
        launchToken,
        tabId,
        worktreeId,
        connectionId: null,
        hasExplicitPrompt:
          source === 'amp'
            ? hasExplicitPromptForSource(source, eventName, promptText, hookPayloadRecord)
              ? true
              : undefined
            : hasExplicitUserPrompt(
                source,
                eventName,
                extractedPrompt,
                resolvedPromptText,
                hasTranscriptPromptEvidence
              ),
        promptInteractionKey,
        hookEventName: typeof eventName === 'string' ? eventName : undefined,
        toolUseId: readFirstString(hookPayloadRecord, ['tool_use_id', 'toolUseId']),
        toolAgentId: readFirstString(hookPayloadRecord, ['agent_id', 'agentId']),
        toolAgentType: readString(hookPayloadRecord, 'agent_type'),
        ...(providerSession ? { providerSession } : {}),
        ...(providerSessionOnly ? { providerSessionOnly: true } : {}),
        payload: transportPayload
      }
    : null
}

// ─── URL routing ────────────────────────────────────────────────────

export const HOOK_SOURCE_BY_PATHNAME: Readonly<Record<string, AgentHookSource>> = Object.freeze({
  '/hook/claude': 'claude',
  '/hook/codex': 'codex',
  '/hook/gemini': 'gemini',
  '/hook/antigravity': 'antigravity',
  '/hook/amp': 'amp',
  '/hook/opencode': 'opencode',
  '/hook/mimo-code': 'mimo-code',
  '/hook/cursor': 'cursor',
  '/hook/pi': 'pi',
  '/hook/omp': 'omp',
  '/hook/droid': 'droid',
  '/hook/command-code': 'command-code',
  '/hook/grok': 'grok',
  '/hook/copilot': 'copilot',
  '/hook/hermes': 'hermes',
  '/hook/devin': 'devin',
  '/hook/kimi': 'kimi'
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

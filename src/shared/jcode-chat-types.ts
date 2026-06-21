// Why: shared between the main-process jcode chat session spawner and the
// renderer ChatPane so both agree on the IPC payload shape. jcode emits
// newline-delimited JSON ("--ndjson"); we forward each parsed object verbatim
// as `event` plus a synthetic `sessionKey` so the renderer can route events to
// the correct chat pane.

/** One parsed jcode --ndjson line. Loosely typed on purpose: jcode owns the
 *  schema and may add event kinds; the renderer switches on `type` and ignores
 *  unknown kinds. The documented kinds (see HANDOFF / M1 brief) are:
 *  start | status_detail | connection_phase | connection_type | tool_start |
 *  tool_input | tool_exec | tool_done | text_delta | message_end | tokens |
 *  done | error. */
export type JcodeNdjsonEvent = {
  type: string
  [key: string]: unknown
}

/** Envelope the main process sends to the renderer over 'jcode-chat:event'. */
export type JcodeChatEventMessage = {
  sessionKey: string
  event: JcodeNdjsonEvent
}

/** Payload the renderer sends over 'jcode-chat:stop' to cancel an in-flight turn. */
export type JcodeChatStopPayload = {
  /** Stable per-pane key whose in-flight jcode child should be killed. */
  sessionKey: string
}

/** An attachment the user added to a chat turn via the composer. Two kinds:
 *  - 'file': an absolute LOCAL path chosen by the native picker or dropped onto
 *    the pane. For remote-exec sessions the main process copies it to the remote
 *    host and rewrites the referenced path before invoking jcode.
 *  - 'text': an inline blob (e.g. a large paste) that should travel in the prompt
 *    fenced, instead of bloating the textarea. */
export type JcodeChatAttachment =
  | {
      kind: 'file'
      /** Absolute local path. */
      path: string
      /** Display name (basename) for the chip. */
      name: string
    }
  | {
      kind: 'text'
      /** Short label for the chip (e.g. "Pasted text"). */
      name: string
      /** The full text content; woven into the prompt fenced on send. */
      content: string
    }

/** Payload the renderer sends over 'jcode-chat:send' to start one turn. */
export type JcodeChatSendPayload = {
  /** Stable per-pane key (tab/worktree id) used to route events back. */
  sessionKey: string
  prompt: string
  /** Files/text the user attached in the composer. The main process weaves them
   *  into the prompt jcode actually receives (and, for remote-exec sessions,
   *  copies local files to the remote host first). */
  attachments?: JcodeChatAttachment[]
  /** jcode provider id, e.g. 'openai'. */
  provider?: string
  /** Named custom OpenAI-compatible provider profile (from `jcode provider add`).
   *  When set, the main process spawns jcode with `--provider-profile <name>`
   *  (which IMPLIES openai-compatible) and OMITS `-p`. Takes precedence over
   *  `provider`. `-m model` is still honored to override the profile default. */
  providerProfile?: string
  /** jcode model id, e.g. 'gpt-5.5'. */
  model?: string
  /** Working directory passed to jcode via -C. */
  cwd?: string
  /** jcode session id (from a prior 'start'/'done' event) to continue a turn. */
  resumeSessionId?: string
  /** Worktree / folder-workspace key for this chat pane. The MAIN process uses
   *  it to resolve brain-local (M3) state authoritatively from its Store: if the
   *  folder workspace is `isRemoteExecOnly`, jcode is spawned LOCALLY with
   *  `--remote-exec <host>` (host from the workspace's SSH target). */
  worktreeId?: string
  /** brain-local (M3): explicit override for the remote-exec host. Normally the
   *  main process resolves the host from `worktreeId`; this is only honored when
   *  no worktree-derived host is available (e.g. ad-hoc callers). */
  remoteExecHost?: string
  /** FEATURE B: name of a skill the user picked from the "/" menu. The main
   *  process re-discovers it (cwd + worktreeId) and prepends its SKILL.md body to
   *  the prompt so the headless model follows it. Kept out of the transcript
   *  bubble (the renderer shows only the user's text + a small skill chip). */
  skillName?: string
}

// ─── FEATURE B: project-specific skills in the "/" menu ─────────────────────
// jcode headless has no native skill loader. "Skills" are SKILL.md files (YAML
// frontmatter `name` + `description`/`when_to_use`, body = instructions) living
// in three source classes: project-local <projectRoot>/.claude/skills/<name>/,
// global ~/.claude/skills/<name>/ (mostly symlinks), and plugin skill dirs from
// ~/.claude/plugins/installed_plugins.json. The main process discovers + parses
// them; on select, the chosen skill's BODY is injected into the outgoing prompt
// so the headless model follows it (no jcode-binary change required).

/** Where a discovered skill came from (for grouping/precedence in the menu). */
export type JcodeSkillSource = 'project' | 'global' | 'plugin'

/** One discovered SKILL.md. `body` is the post-frontmatter instruction text that
 *  is injected into the prompt when the skill is selected. */
export type JcodeSkill = {
  /** Skill name (frontmatter `name`, or the directory name). Plugin skills are
   *  namespaced as `plugin:skill` to mirror Claude Code and avoid collisions. */
  name: string
  /** One-line-ish summary (frontmatter `description` || `when_to_use`). */
  description: string
  /** Instruction body after the frontmatter, injected on select. */
  body: string
  source: JcodeSkillSource
  /** Owning plugin id for `source === 'plugin'` (e.g. superpowers@marketplace). */
  pluginId?: string
}

/** Result of a skills-list call. `degraded` is true when a remote project's
 *  project-local skills could not be read (no live SSH connection), so only
 *  global + plugin skills are returned. */
export type JcodeSkillsListResult = {
  skills: JcodeSkill[]
  /** True when project-local (remote) skills were unavailable; UI may note it. */
  degraded?: boolean
}

/** Renderer -> main payload to list skills for the current chat pane. */
export type JcodeSkillsListPayload = {
  /** Project root for project-local `.claude/skills` discovery (the pane's cwd).
   *  For a remote worktree this is the REMOTE path; main resolves the SSH target
   *  from `worktreeId` and reads it over the connection. */
  cwd?: string
  /** Worktree / folder-workspace key so main can resolve a remote project. */
  worktreeId?: string
}

export const JCODE_SKILLS_LIST_CHANNEL = 'jcode-skills:list'

// ─── MCP servers / connectors ───────────────────────────────────────────────
// jcode loads stdio MCP servers from ~/.jcode/mcp.json (Claude-Desktop format:
// { "servers": { "<name>": { command, args, env, shared } } }) and exposes their
// tools to the agent. orca manages the GLOBAL file so the user can add/remove
// connectors from the GUI. Remote/hosted MCP servers work via a stdio bridge,
// e.g. command "npx", args ["mcp-remote", "https://…"].

/** Renderer -> main: read the global ~/.jcode/mcp.json server list. */
export const JCODE_MCP_GET_CHANNEL = 'jcodeMcp:get'
/** Renderer -> main: overwrite the global ~/.jcode/mcp.json server list. */
export const JCODE_MCP_SET_CHANNEL = 'jcodeMcp:set'

/** One stdio MCP server entry (mirrors jcode's McpServerConfig). */
export type JcodeMcpServer = {
  /** Server name == its key in mcp.json. */
  name: string
  /** Executable to spawn (stdio transport), e.g. "npx" or an absolute path. */
  command: string
  /** Arguments passed to the command. */
  args: string[]
  /** Extra environment variables for the child process. */
  env: Record<string, string>
  /** Whether the server may be shared across sessions (jcode default: true). */
  shared: boolean
}

/** Result of jcodeMcp:get. */
export type JcodeMcpConfigResult = {
  ok: boolean
  error?: string
  /** Servers from the global ~/.jcode/mcp.json (the file orca manages). */
  servers: JcodeMcpServer[]
  /** Absolute path to the managed file (shown in the UI). */
  path?: string
}

/** Renderer -> main args for jcodeMcp:set. */
export type JcodeMcpSetArgs = {
  servers: JcodeMcpServer[]
}

/** Result of jcodeMcp:set. */
export type JcodeMcpActionResult = {
  ok: boolean
  error?: string
}

/** Authentication style jcode uses for a custom OpenAI-compatible provider. */
export type JcodeProviderAuth = 'bearer' | 'api-key' | 'none'

/** A user-added custom OpenAI-compatible provider profile. The API key is NOT
 *  stored here — it lives in jcode's private provider env file (written via
 *  `jcode provider add --api-key-stdin`). This record only mirrors the
 *  non-secret config so the composer + settings can list profiles. */
export type JcodeCustomProvider = {
  /** Profile name; passed to jcode as `--provider-profile <name>`. */
  name: string
  /** OpenAI-compatible base URL, e.g. https://llm.example.com/v1 */
  baseUrl: string
  /** Default model id for this profile. */
  model: string
  /** Auth style; defaults to 'bearer' when omitted. */
  auth?: JcodeProviderAuth
}

/** Renderer -> main args to add a custom provider. The API key (when present)
 *  is delivered over the child's STDIN, never as an argv flag. */
export type JcodeProviderAddArgs = {
  name: string
  baseUrl: string
  model: string
  auth?: JcodeProviderAuth
  /** Optional custom auth header name (jcode `--auth-header`). */
  authHeader?: string
  /** API key value; written to jcode's stdin via `--api-key-stdin`. When empty
   *  / omitted the provider is added with `--no-api-key`. */
  apiKey?: string
}

/** Result of a jcodeProviders:add / :list call. */
export type JcodeProviderActionResult = {
  ok: boolean
  /** Normalized error message when ok === false. */
  error?: string
  /** The persisted (non-secret) profile, on a successful add. */
  provider?: JcodeCustomProvider
}

export const JCODE_PROVIDERS_LIST_CHANNEL = 'jcodeProviders:list'
export const JCODE_PROVIDERS_ADD_CHANNEL = 'jcodeProviders:add'
/** Renderer -> main: shell `jcode model list --json` for the real model catalog
 *  (provider/availability/routes) used by the composer's detailed model picker. */
export const JCODE_MODELS_LIST_CHANNEL = 'jcodeProviders:listModels'

/** One per-model route from `jcode model list --json`: which provider serves the
 *  model, the auth method, and whether it's usable right now (authed). */
export type JcodeModelRoute = {
  /** Provider DISPLAY name as jcode reports it, e.g. "OpenAI", "Anthropic". */
  provider: string
  model: string
  /** Auth method, e.g. "oauth" | "api_key". Informational. */
  method?: string
  /** True when this model can be used now (provider is authed). */
  available: boolean
}

/** Parsed result of `jcode model list --json` for the composer picker. */
export type JcodeModelCatalog = {
  ok: boolean
  /** Normalized error message when ok === false. */
  error?: string
  /** Currently resolved provider display name (what "Auto" picks). */
  provider?: string
  /** Currently resolved model id (what "Auto" picks). */
  selectedModel?: string
  /** Flat list of model ids in the resolved provider's catalog. */
  models: string[]
  /** Per-model provider + availability routing. */
  routes: JcodeModelRoute[]
}

export const JCODE_CHAT_SEND_CHANNEL = 'jcode-chat:send'
export const JCODE_CHAT_STOP_CHANNEL = 'jcode-chat:stop'
export const JCODE_CHAT_EVENT_CHANNEL = 'jcode-chat:event'
/** Renderer -> main: open a native multi-select file picker; resolves to the
 *  chosen ABSOLUTE paths (empty array on cancel). */
export const JCODE_CHAT_PICK_FILES_CHANNEL = 'jcode-chat:pickFiles'

// ─── Durable persistence (BUG 1/2) ─────────────────────────────────────────
// jcode conversations are mirrored to disk in the main process so they survive
// app restart and a closed chat tab can be reopened + rehydrated. The renderer
// keeps its in-memory external store as the live layer; disk is the backing
// store. A conversation is keyed by `sessionKey` (the chat tab id), which the
// renderer recreates with a stable id on reopen so the keys line up.

/** A single persisted chat message (mirrors the renderer ChatMessage, but with
 *  the tool-call shape kept structural so shared code needn't import renderer
 *  types). Loosely typed `tools` because the tool-card shape lives in the
 *  renderer; the store round-trips it verbatim. */
export type JcodePersistedMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  tools?: unknown[]
  isError?: boolean
}

/** The full on-disk record for one conversation. */
export type JcodeConversationRecord = {
  /** Stable conversation id == the chat tab's sessionKey on first create. */
  sessionKey: string
  /** Worktree / folder-workspace key, so reopen can recreate the tab in place. */
  worktreeId?: string
  /** cwd the chat was launched with (best-effort; informational). */
  cwd?: string
  /** Human label for lists ("Recent chats"). Derived from the first user prompt. */
  title: string
  /** Last-activity timestamp (ms) for sorting recents. */
  updatedAt: number
  /** jcode --resume id so a reopened chat continues the same jcode session. */
  resumeSessionId?: string
  /** Persisted composer chip selection. */
  composerProvider?: string
  composerModel?: string
  /** Persisted custom provider profile selection (mutually exclusive with
   *  composerProvider; when set the chip points at a `jcode provider add` profile). */
  composerProviderProfile?: string
  /** The transcript. Capped to a max length on write to bound file growth. */
  messages: JcodePersistedMessage[]
}

/** Lightweight row returned by listConversations (no transcript body). */
export type JcodeConversationSummary = {
  sessionKey: string
  worktreeId?: string
  cwd?: string
  title: string
  updatedAt: number
  resumeSessionId?: string
}

export const JCODE_CHAT_LIST_CHANNEL = 'jcode-chat:listConversations'
export const JCODE_CHAT_LOAD_CHANNEL = 'jcode-chat:loadConversation'
export const JCODE_CHAT_DELETE_CHANNEL = 'jcode-chat:deleteConversation'
/** Renderer -> main: persist a snapshot of the live conversation state. */
export const JCODE_CHAT_SAVE_CHANNEL = 'jcode-chat:saveConversation'

/** Payload the renderer sends to persist a conversation snapshot. Sent on turn
 *  boundaries (start + done/error/stopped/exit), debounced, so we capture the
 *  full transcript and the latest --resume id without thrashing disk. */
export type JcodeChatSavePayload = {
  record: JcodeConversationRecord
}

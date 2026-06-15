import { describeToolActivity } from './tool-activity'

// Minimal local type — avoids main/renderer coupling
type ClaudeStreamEvent = { type: string; [k: string]: unknown }

export type ChatItem =
  | { role: 'user'; id: string; text: string }
  | { role: 'assistant'; id: string; text: string }
  | {
      role: 'tool_use'
      id: string
      toolUseId: string
      toolName: string
      input: unknown
      result?: string
      isError?: boolean
    }
  | { role: 'checkpoint'; id: string; sha: string; createdAt: string; label: string }
  | { role: 'thinking'; id: string; text: string }
  | { role: 'info'; id: string; text: string }

export type ChatUsage = {
  // Context size of the latest API call (input + cache read + cache creation).
  contextTokens: number
  // Cumulative output tokens across all turns of this conversation.
  outputTokens: number
  // Cumulative cost in USD across all turns.
  costUsd: number
}

export type ChatState = {
  items: ChatItem[]
  sessionId: string | null
  running: boolean
  // Live model reported by Claude Code's system:init event — the source of truth.
  activeModel: string | null
  // In-flight partial text/thinking from stream_event deltas; null when idle.
  stream: { text: string; thinking: string } | null
  // Short live status like the official GUI: "Thinking…", "Editing foo.ts…".
  activity: string | null
  usage: ChatUsage | null
}

export type ChatAction =
  | { kind: 'localUser'; text: string }
  | { kind: 'setRunning'; running: boolean }
  | { kind: 'event'; event: ClaudeStreamEvent }
  | { kind: 'loadTranscript'; events: unknown[]; sessionId: string }
  | { kind: 'info'; text: string }

export function initialChatState(): ChatState {
  return {
    items: [],
    sessionId: null,
    running: false,
    activeModel: null,
    stream: null,
    activity: null,
    usage: null
  }
}

function makeId(items: ChatItem[]): string {
  return `item-${items.length}-${Date.now()}`
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  return JSON.stringify(content)
}

export function reduceChat(state: ChatState, action: ChatAction): ChatState {
  switch (action.kind) {
    case 'localUser': {
      const item: ChatItem = { role: 'user', id: makeId(state.items), text: action.text }
      return { ...state, items: [...state.items, item] }
    }

    case 'info': {
      const item: ChatItem = { role: 'info', id: makeId(state.items), text: action.text }
      return { ...state, items: [...state.items, item] }
    }

    case 'setRunning': {
      if (!action.running) {
        // Stop: drop any in-flight stream/activity remnants.
        return { ...state, running: false, stream: null, activity: null }
      }
      return { ...state, running: true }
    }

    case 'event': {
      const { event } = action
      if (event.type === 'stream_event') {
        const inner = (
          event as { event?: { type?: string; delta?: unknown; content_block?: unknown } }
        ).event
        if (inner?.type === 'content_block_start') {
          const block = inner.content_block as { type?: string } | undefined
          if (block?.type === 'thinking') {
            return { ...state, activity: 'Thinking…' }
          }
          if (block?.type === 'text') {
            return { ...state, activity: null }
          }
          return state
        }
        if (inner?.type === 'content_block_delta') {
          const delta = inner.delta as { type?: string; text?: string; thinking?: string }
          const cur = state.stream ?? { text: '', thinking: '' }
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            return { ...state, stream: { ...cur, text: cur.text + delta.text } }
          }
          if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            return { ...state, stream: { ...cur, thinking: cur.thinking + delta.thinking } }
          }
        }
        return state
      }

      if (event.type === 'checkpoint') {
        const cp = event as unknown as { sha: string; createdAt: string; label: string }
        const item: ChatItem = {
          role: 'checkpoint',
          id: makeId(state.items),
          sha: cp.sha,
          createdAt: cp.createdAt,
          label: cp.label
        }
        return { ...state, items: [...state.items, item] }
      }

      if (event.type === 'system' && (event as { subtype?: string }).subtype === 'init') {
        const init = event as unknown as { session_id: string; model?: string }
        return {
          ...state,
          sessionId: init.session_id,
          activeModel: init.model ?? state.activeModel
        }
      }

      if (event.type === 'assistant') {
        const message = (event as unknown as { message: { content: unknown[] } }).message
        const newItems: ChatItem[] = []
        for (const block of message.content) {
          const b = block as { type: string; [k: string]: unknown }
          if (b.type === 'text') {
            newItems.push({
              role: 'assistant',
              id: makeId([...state.items, ...newItems]),
              text: b.text as string
            })
          } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
            newItems.push({
              role: 'thinking',
              id: makeId([...state.items, ...newItems]),
              text: b.thinking
            })
          } else if (b.type === 'tool_use') {
            newItems.push({
              role: 'tool_use',
              id: makeId([...state.items, ...newItems]),
              toolUseId: b.id as string,
              toolName: b.name as string,
              input: b.input
            })
          }
        }
        // Why: the complete assistant message supersedes the streamed partial.
        // A trailing tool_use sets the live activity label ("Editing foo.ts…").
        const lastTool = [...newItems].reverse().find((i) => i.role === 'tool_use')
        const activity =
          lastTool && lastTool.role === 'tool_use'
            ? describeToolActivity(lastTool.toolName, lastTool.input)
            : state.activity
        return { ...state, items: [...state.items, ...newItems], stream: null, activity }
      }

      if (event.type === 'user') {
        const message = (event as unknown as { message: { content: unknown } }).message
        // content may be a string (transcript shorthand) or an array of blocks
        const rawContent = message.content
        if (typeof rawContent === 'string') {
          // Why: transcript user events sometimes have a plain string content.
          const item: ChatItem = { role: 'user', id: makeId(state.items), text: rawContent }
          return { ...state, items: [...state.items, item] }
        }
        const blocks = rawContent as unknown[]
        let items = state.items
        let sawToolResult = false
        for (const block of blocks) {
          const b = block as {
            type: string
            tool_use_id: string
            content: unknown
            is_error: boolean
            text?: string
          }
          if (b.type === 'tool_result') {
            sawToolResult = true
            items = items.map((item) => {
              if (item.role === 'tool_use' && item.toolUseId === b.tool_use_id) {
                return { ...item, result: stringifyContent(b.content), isError: b.is_error }
              }
              return item
            })
          } else if (b.type === 'text' && typeof b.text === 'string') {
            // Why: transcript user messages may contain text blocks (not just tool_result).
            items = [...items, { role: 'user', id: makeId(items), text: b.text }]
          }
        }
        // Why: tool result received → the model is processing it before its next step.
        return { ...state, items, activity: sawToolResult ? 'Thinking…' : state.activity }
      }

      if (event.type === 'result') {
        const r = event as {
          is_error?: boolean
          errors?: unknown[]
          total_cost_usd?: number
          usage?: {
            input_tokens?: number
            output_tokens?: number
            cache_read_input_tokens?: number
            cache_creation_input_tokens?: number
          }
        }
        const u = r.usage
        const usage: ChatUsage | null = u
          ? {
              contextTokens:
                (u.input_tokens ?? 0) +
                (u.cache_read_input_tokens ?? 0) +
                (u.cache_creation_input_tokens ?? 0),
              outputTokens: (state.usage?.outputTokens ?? 0) + (u.output_tokens ?? 0),
              costUsd: (state.usage?.costUsd ?? 0) + (r.total_cost_usd ?? 0)
            }
          : state.usage
        // Why: failures were previously silent — surface them in the conversation.
        let errorTexts = r.is_error
          ? (r.errors ?? []).filter((e): e is string => typeof e === 'string')
          : []
        if (r.is_error && errorTexts.length === 0) {
          const fallback = (event as { result?: unknown; subtype?: unknown }).result
          errorTexts = [typeof fallback === 'string' ? fallback : 'Claude exited with an error']
        }
        const items =
          errorTexts.length > 0
            ? [
                ...state.items,
                {
                  role: 'info' as const,
                  id: makeId(state.items),
                  text: `⚠ ${errorTexts.join(' — ')}`
                }
              ]
            : state.items
        return { ...state, items, running: false, stream: null, activity: null, usage }
      }

      return state
    }

    case 'loadTranscript': {
      // Why: fold each transcript event through the 'event' branch starting from
      // a blank slate, then stamp the known sessionId from the history API.
      const blank: ChatState = {
        items: [],
        sessionId: action.sessionId,
        running: false,
        activeModel: state.activeModel,
        stream: null,
        activity: null,
        usage: null
      }
      const loaded = action.events.reduce(
        (s: ChatState, e: unknown) =>
          reduceChat(s, { kind: 'event', event: e as ClaudeStreamEvent }),
        blank
      )
      return { ...loaded, sessionId: action.sessionId, running: false, activity: null }
    }
  }
}

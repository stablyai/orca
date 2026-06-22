import type { JcodeNdjsonEvent } from '../../../../shared/jcode-chat-types'
import type { JcodeToolCall } from './JcodeToolCard'
import type { ChatMessage, ChatSessionState } from './chat-session-types'

function strField(event: JcodeNdjsonEvent, key: string): string | undefined {
  const value = event[key]
  return typeof value === 'string' ? value : undefined
}

/** Insert-or-update a tool call on the streaming assistant message by id. */
function upsertTool(
  state: ChatSessionState,
  id: string,
  mutate: (call: JcodeToolCall) => JcodeToolCall,
  fallbackName = 'tool'
): ChatSessionState {
  const targetId = state.streamingId
  if (!targetId) {
    return state
  }
  return {
    ...state,
    messages: state.messages.map((m) => {
      if (m.id !== targetId) {
        return m
      }
      const tools = m.tools ?? []
      const index = tools.findIndex((t) => t.id === id)
      if (index === -1) {
        const created = mutate({ id, name: fallbackName, rawInput: '', status: 'running' })
        return { ...m, tools: [...tools, created] }
      }
      const next = tools.slice()
      next[index] = mutate(next[index])
      return { ...m, tools: next }
    })
  }
}

function appendToStreaming(
  state: ChatSessionState,
  mutate: (msg: ChatMessage) => ChatMessage
): ChatSessionState {
  const targetId = state.streamingId
  if (!targetId) {
    return state
  }
  return {
    ...state,
    messages: state.messages.map((m) => (m.id === targetId ? mutate(m) : m))
  }
}

function finalizeTurn(state: ChatSessionState): ChatSessionState {
  return { ...state, isStreaming: false, statusDetail: null, streamingId: null }
}

export function reduceJcodeEvent(
  previous: ChatSessionState,
  event: JcodeNdjsonEvent
): ChatSessionState {
  switch (event.type) {
    case 'start': {
      const id = strField(event, 'session_id')
      return id ? { ...previous, resumeSessionId: id } : previous
    }
    case 'status_detail': {
      const detail = strField(event, 'detail')
      return detail ? { ...previous, statusDetail: detail } : previous
    }
    case 'connection_phase': {
      const phase = strField(event, 'phase')
      return phase ? { ...previous, statusDetail: phase } : previous
    }
    case 'text_delta': {
      const text = strField(event, 'text') ?? ''
      if (!text) {
        return previous
      }
      return appendToStreaming({ ...previous, statusDetail: null }, (m) => ({
        ...m,
        text: m.text + text
      }))
    }
    case 'tool_start': {
      const id = strField(event, 'id') ?? `tool-${Date.now()}`
      const name = strField(event, 'name') ?? 'tool'
      return upsertTool(previous, id, (call) => ({ ...call, name }), name)
    }
    case 'tool_input': {
      const id = strField(event, 'id')
      const delta = strField(event, 'delta') ?? ''
      if (!id) {
        return previous
      }
      return upsertTool(previous, id, (call) => ({ ...call, rawInput: call.rawInput + delta }))
    }
    case 'tool_exec': {
      const id = strField(event, 'id') ?? `tool-${Date.now()}`
      const name = strField(event, 'name') ?? 'tool'
      return upsertTool(previous, id, (call) => ({ ...call, status: 'running' }), name)
    }
    case 'tool_done': {
      const id = strField(event, 'id')
      const errorText = strField(event, 'error')
      const output = strField(event, 'output')
      if (!id) {
        return previous
      }
      return upsertTool(previous, id, (call) => ({
        ...call,
        output: output ?? call.output,
        error: errorText ?? undefined,
        status: errorText ? 'error' : 'done'
      }))
    }
    case 'done': {
      const id = strField(event, 'session_id')
      let next = id ? { ...previous, resumeSessionId: id } : previous
      const finalText = strField(event, 'text')
      if (finalText) {
        next = appendToStreaming(next, (m) => (m.text ? m : { ...m, text: finalText }))
      }
      return finalizeTurn(next)
    }
    case 'error': {
      const message =
        strField(event, 'error') ?? strField(event, 'message') ?? 'Unknown jcode error'
      const next = appendToStreaming(previous, (m) => ({
        ...m,
        text: m.text + message,
        isError: true
      }))
      return finalizeTurn(next)
    }
    case 'stopped': {
      const next = appendToStreaming(previous, (m) => ({
        ...m,
        text: m.text ? `${m.text}\n\n(stopped)` : '(stopped)'
      }))
      return finalizeTurn(next)
    }
    case 'exit': {
      return previous.streamingId ? finalizeTurn(previous) : previous
    }
    default:
      return previous
  }
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type { JcodeChatEventMessage, JcodeNdjsonEvent } from '../../../../shared/jcode-chat-types'

// Why: M1 chat-bubble view for the jcode agent. Talking to jcode shows replies
// as chat bubbles instead of a raw terminal. The NDJSON parsing/render logic is
// ported from the proven jcode-desktop prototype (src/app.js): text_delta
// streams into the assistant bubble; tool_* events render a one-line placeholder
// (full tool cards are M2); the jcode session_id from 'start'/'done' is captured
// for --resume so the conversation continues across turns.

type ChatRole = 'user' | 'assistant'

type ToolPlaceholder = {
  id: string
  name: string
}

type ChatMessage = {
  id: string
  role: ChatRole
  text: string
  /** One-line placeholders for tool calls seen during this assistant turn. */
  tools?: ToolPlaceholder[]
  isError?: boolean
}

function strField(event: JcodeNdjsonEvent, key: string): string | undefined {
  const value = event[key]
  return typeof value === 'string' ? value : undefined
}

export default function ChatPane({
  sessionKey,
  cwd,
  provider = 'openai',
  model
}: {
  sessionKey: string
  cwd?: string
  provider?: string
  model?: string
}): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [statusDetail, setStatusDetail] = useState<string | null>(null)

  // Why: refs hold turn-scoped mutable state that must not trigger re-renders on
  // every NDJSON delta. The assistant message id being streamed into, and the
  // jcode session id to resume on the next turn.
  const streamingIdRef = useRef<string | null>(null)
  const resumeSessionIdRef = useRef<string | undefined>(undefined)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const bottom = scrollRef.current
    if (bottom) {
      bottom.scrollTop = bottom.scrollHeight
    }
  }, [messages, statusDetail])

  const appendToStreaming = useCallback((mutate: (msg: ChatMessage) => ChatMessage) => {
    const targetId = streamingIdRef.current
    if (!targetId) {
      return
    }
    setMessages((prev) => prev.map((m) => (m.id === targetId ? mutate(m) : m)))
  }, [])

  const finalizeTurn = useCallback(() => {
    setIsStreaming(false)
    setStatusDetail(null)
    streamingIdRef.current = null
  }, [])

  const handleEvent = useCallback(
    (event: JcodeNdjsonEvent) => {
      switch (event.type) {
        case 'start': {
          const id = strField(event, 'session_id')
          if (id) {
            resumeSessionIdRef.current = id
          }
          break
        }
        case 'status_detail': {
          const detail = strField(event, 'detail')
          if (detail) {
            setStatusDetail(detail)
          }
          break
        }
        case 'connection_phase': {
          const phase = strField(event, 'phase')
          if (phase) {
            setStatusDetail(phase)
          }
          break
        }
        case 'text_delta': {
          const text = strField(event, 'text') ?? ''
          if (text) {
            setStatusDetail(null)
            appendToStreaming((m) => ({ ...m, text: m.text + text }))
          }
          break
        }
        case 'tool_start':
        case 'tool_exec': {
          const id = strField(event, 'id') ?? `${event.type}-${Date.now()}`
          const name = strField(event, 'name') ?? 'tool'
          appendToStreaming((m) => {
            const tools = m.tools ?? []
            if (tools.some((t) => t.id === id)) {
              return m
            }
            return { ...m, tools: [...tools, { id, name }] }
          })
          break
        }
        case 'done': {
          // Why: jcode may include the full final text in 'done' even when no
          // text_delta arrived (e.g. cached); backfill an empty bubble.
          const id = strField(event, 'session_id')
          if (id) {
            resumeSessionIdRef.current = id
          }
          const finalText = strField(event, 'text')
          if (finalText) {
            appendToStreaming((m) => (m.text ? m : { ...m, text: finalText }))
          }
          finalizeTurn()
          break
        }
        case 'error': {
          const message =
            strField(event, 'error') ?? strField(event, 'message') ?? 'Unknown jcode error'
          appendToStreaming((m) => ({ ...m, text: m.text + message, isError: true }))
          finalizeTurn()
          break
        }
        case 'exit': {
          // Terminal safety net: if the child exited without 'done'/'error',
          // close the turn so the composer re-enables.
          if (streamingIdRef.current) {
            finalizeTurn()
          }
          break
        }
        default:
          // Ignore unknown / not-yet-rendered event kinds (tool_input,
          // tool_done, message_end, tokens, connection_type) for M1.
          break
      }
    },
    [appendToStreaming, finalizeTurn]
  )

  useEffect(() => {
    const unsubscribe = window.api.jcodeChat.onEvent((message: JcodeChatEventMessage) => {
      if (message.sessionKey !== sessionKey) {
        return
      }
      handleEvent(message.event)
    })
    return unsubscribe
  }, [sessionKey, handleEvent])

  const send = useCallback(() => {
    const prompt = input.trim()
    if (!prompt || isStreaming) {
      return
    }
    const userId = `user-${Date.now()}`
    const assistantId = `assistant-${Date.now()}`
    setMessages((prev) => [
      ...prev,
      { id: userId, role: 'user', text: prompt },
      { id: assistantId, role: 'assistant', text: '' }
    ])
    streamingIdRef.current = assistantId
    setInput('')
    setIsStreaming(true)
    setStatusDetail('Thinking…')
    window.api.jcodeChat.send({
      sessionKey,
      prompt,
      provider,
      model,
      cwd,
      resumeSessionId: resumeSessionIdRef.current
    })
  }, [input, isStreaming, sessionKey, provider, model, cwd])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Ask jcode anything. Replies stream in as chat bubbles.
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={cn(
                    'max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm',
                    message.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-foreground',
                    message.isError && 'bg-destructive/15 text-destructive'
                  )}
                >
                  {message.tools && message.tools.length > 0 ? (
                    <div className="mb-1 flex flex-col gap-0.5">
                      {message.tools.map((tool) => (
                        <div key={tool.id} className="text-xs text-muted-foreground">
                          {`⚙ ${tool.name}`}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {message.text || (message.role === 'assistant' && isStreaming ? '…' : '')}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {statusDetail ? (
        <div className="px-4 pb-1 text-xs text-muted-foreground">{statusDetail}</div>
      ) : null}
      <div className="border-t border-border p-3">
        <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                send()
              }
            }}
            placeholder="Message jcode…"
            rows={1}
            className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <button
            type="button"
            onClick={send}
            disabled={isStreaming || !input.trim()}
            className={cn(
              'rounded-md px-3 py-2 text-sm font-medium',
              'bg-primary text-primary-foreground',
              'disabled:cursor-not-allowed disabled:opacity-50'
            )}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}

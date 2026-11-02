import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronDown, ChevronRight, Loader2, Send, Square } from 'lucide-react'
import { cn } from '@/lib/utils'

export type MobileChatTool = {
  name: string
  input?: string
  output?: string
  state?: string
}

export type MobileChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'reasoning' | 'system'
  content: string
  reasoning?: string
  tools?: MobileChatTool[]
  timestamp?: number
}

export type MobilePendingInteraction = {
  interactionId: string
  revision?: number
  kind?: 'approval' | 'question'
  title?: string
  command: string
  dangerLevel?: string
  options?: { id: string; label: string }[]
}

export type MobileChatViewProps = {
  title: string
  messages: readonly MobileChatMessage[]
  pendingInteraction?: MobilePendingInteraction | null
  connectionState?: 'connecting' | 'connected' | 'offline'
  sending?: boolean
  resolving?: boolean
  error?: string | null
  onSendPrompt: (prompt: string) => void
  onResolveInteraction: (interactionId: string, decision: 'approve' | 'deny') => void
  onStop?: () => void
  onBack: () => void
}

function ToolRow({ tool }: { tool: MobileChatTool }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-lg border border-border/70 bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="font-mono font-semibold">{tool.name}</span>
        {tool.state ? (
          <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {tool.state}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="space-y-2 border-t border-border/60 px-2.5 py-2">
          {tool.input ? (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-background/70 p-2 font-mono text-[10px] text-muted-foreground">
              {tool.input}
            </pre>
          ) : null}
          {tool.output ? (
            <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all rounded bg-background/70 p-2 font-mono text-[10px]">
              {tool.output}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function MessageBubble({ message }: { message: MobileChatMessage }): React.JSX.Element {
  const [reasoningOpen, setReasoningOpen] = useState(false)
  if (message.role === 'system') {
    return (
      <div className="flex justify-center py-1">
        <span className="max-w-[92%] rounded-full bg-muted px-3 py-1 text-center text-[11px] text-muted-foreground">
          {message.content}
        </span>
      </div>
    )
  }
  if (message.role === 'reasoning') {
    return (
      <div className="max-w-[92%] rounded-xl border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <button
          type="button"
          onClick={() => setReasoningOpen((value) => !value)}
          className="flex items-center gap-1.5 font-medium"
        >
          {reasoningOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Thinking
        </button>
        {reasoningOpen ? (
          <p className="mt-2 whitespace-pre-wrap leading-5">{message.content}</p>
        ) : null}
      </div>
    )
  }
  return (
    <div className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[88%] space-y-2 rounded-2xl px-3 py-2 text-sm leading-5',
          message.role === 'user'
            ? 'rounded-br-md bg-primary text-primary-foreground'
            : 'rounded-bl-md border border-border/70 bg-card text-foreground'
        )}
      >
        {message.reasoning ? (
          <div className="rounded-lg border border-border/60 bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">
            <button
              type="button"
              onClick={() => setReasoningOpen((value) => !value)}
              className="flex items-center gap-1.5 font-medium"
            >
              {reasoningOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Thinking
            </button>
            {reasoningOpen ? (
              <p className="mt-2 whitespace-pre-wrap leading-5">{message.reasoning}</p>
            ) : null}
          </div>
        ) : null}
        {message.content ? (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        ) : null}
        {message.tools?.map((tool, index) => (
          <ToolRow key={`${message.id}:tool:${index}`} tool={tool} />
        ))}
      </div>
    </div>
  )
}

export function MobileChatView({
  title,
  messages,
  pendingInteraction,
  connectionState = 'connected',
  sending = false,
  resolving = false,
  error = null,
  onSendPrompt,
  onResolveInteraction,
  onStop,
  onBack
}: MobileChatViewProps): React.JSX.Element {
  const [inputText, setInputText] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)
  const lastCountRef = useRef(0)

  useEffect(() => {
    if (messages.length === lastCountRef.current) {
      return
    }
    lastCountRef.current = messages.length
    const list = listRef.current
    if (list) {
      list.scrollTop = list.scrollHeight
    }
  }, [messages.length])

  const handleSend = (): void => {
    const trimmed = inputText.trim()
    if (!trimmed || sending) {
      return
    }
    onSendPrompt(trimmed)
    setInputText('')
  }

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex items-center gap-2 border-b border-border/70 bg-background/95 px-3 pb-2 pt-[max(0.65rem,env(safe-area-inset-top))] backdrop-blur">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to tasks"
          className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted/50 text-muted-foreground active:scale-95"
        >
          <ArrowLeft size={16} aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{title}</h1>
          <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span
              className={cn(
                'size-1.5 rounded-full',
                connectionState === 'connected'
                  ? 'bg-emerald-500'
                  : connectionState === 'connecting'
                    ? 'animate-pulse bg-amber-500'
                    : 'bg-destructive'
              )}
              aria-hidden
            />
            {connectionState === 'connected'
              ? 'Live'
              : connectionState === 'connecting'
                ? 'Connecting…'
                : 'Offline'}
          </p>
        </div>
        {onStop ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop agent"
            className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted/50 text-muted-foreground active:scale-95"
          >
            <Square size={13} aria-hidden />
          </button>
        ) : null}
      </header>

      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground">
            <Loader2 size={14} className="animate-spin" aria-hidden />
            Waiting for agent output…
          </div>
        ) : (
          messages.map((message) => <MessageBubble key={message.id} message={message} />)
        )}
      </div>

      {error ? (
        <div className="mx-3 mb-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {pendingInteraction ? (
        <div className="mx-3 mb-2 rounded-xl border border-amber-500/50 bg-amber-500/10 p-3 shadow-lg">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
            <span aria-hidden>⚠️</span>
            {pendingInteraction.kind === 'question'
              ? (pendingInteraction.title ?? 'Agent question')
              : (pendingInteraction.title ?? 'Agent requests permission')}
          </div>
          <pre className="mb-3 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background/80 p-2.5 font-mono text-[11px] text-foreground">
            {pendingInteraction.command}
          </pre>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={resolving}
              onClick={() =>
                onResolveInteraction(pendingInteraction.interactionId, 'deny')
              }
              className="rounded-lg border border-border bg-background py-3 text-sm font-semibold text-foreground active:scale-[0.99] disabled:opacity-50"
            >
              拒绝
            </button>
            <button
              type="button"
              disabled={resolving}
              onClick={() =>
                onResolveInteraction(pendingInteraction.interactionId, 'approve')
              }
              className="rounded-lg bg-emerald-600 py-3 text-sm font-semibold text-white active:scale-[0.99] disabled:opacity-50"
            >
              {resolving ? '处理中…' : '允许执行'}
            </button>
          </div>
        </div>
      ) : null}

      <div className="border-t border-border/70 bg-background px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
        <div className="flex items-end gap-2">
          <textarea
            rows={1}
            value={inputText}
            onChange={(event) => setInputText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                handleSend()
              }
            }}
            placeholder="Send an instruction to the agent…"
            className="max-h-32 min-h-10 flex-1 resize-none rounded-xl border border-border bg-muted/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!inputText.trim() || sending}
            aria-label="Send prompt"
            className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground active:scale-95 disabled:opacity-50"
          >
            {sending ? (
              <Loader2 size={16} className="animate-spin" aria-hidden />
            ) : (
              <Send size={16} aria-hidden />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

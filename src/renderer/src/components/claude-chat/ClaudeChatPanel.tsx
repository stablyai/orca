import React, { useCallback, useEffect, useRef, useState } from 'react'
import { StopCircle, Send, Paperclip, X, History, SquarePen } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useClaudeChat } from './useClaudeChat'
import type { ChatItem } from './chat-message-model'
import { ChatMessageItem } from './ChatMessageItem'
import { ClaudeChatHistoryView } from './ClaudeChatHistoryView'
import { ClaudeChatModelSelect } from './ClaudeChatModelSelect'
import { ChatStreamTail } from './ChatStreamTail'
import { ChatUsageBar } from './ChatUsageBar'
import { ChatMcpPopover } from './ChatMcpPopover'
import { ChatSlashMenu, useSlashCommands, filterSlashCommands } from './ChatSlashMenu'

// Why: Electron File objects in the renderer carry an extra `.path` property
// that exposes the absolute filesystem path, not available in standard browser File.
type ElectronFile = File & { path: string }

function basenameOf(filePath: string): string {
  // Why: use platform-agnostic split to avoid assuming path separator.
  return filePath.split(/[\\/]/).pop() ?? filePath
}

type Checkpoint = Extract<ChatItem, { role: 'checkpoint' }>
type PairedItem = { item: ChatItem; checkpoint?: Checkpoint }

// Why: a checkpoint event lands right after its user message; pair them so the
// checkpoint shows as hover controls on that bubble instead of a divider row.
function pairCheckpoints(items: ChatItem[]): PairedItem[] {
  const out: PairedItem[] = []
  for (const item of items) {
    if (item.role === 'checkpoint') {
      const prev = out.at(-1)
      if (prev && prev.item.role === 'user' && !prev.checkpoint) {
        prev.checkpoint = item
        continue
      }
      continue
    }
    out.push({ item })
  }
  return out
}

export function ClaudeChatPanel(): React.JSX.Element {
  // Why: replicate the same selector pattern as the right-sidebar index.tsx
  // which derives the active worktree from activeWorktreeId + getKnownWorktreeById.
  const worktree = useAppStore((s) =>
    s.activeWorktreeId ? (s.getKnownWorktreeById(s.activeWorktreeId) ?? null) : null
  )

  const worktreeId = worktree?.id ?? null
  // Why: worktree.path is the filesystem root of the working tree, which is
  // what claude-code expects as cwd.
  const cwd = worktree?.path ?? null

  const { state, sendMessage, stop, loadSession, newChat, dispatch } = useClaudeChat(
    worktreeId,
    cwd
  )

  const handleCheckpointReverted = useCallback(
    (timeLabel: string) => {
      dispatch({ kind: 'info', text: `Reverted files to checkpoint ${timeLabel}` })
    },
    [dispatch]
  )

  const [showHistory, setShowHistory] = useState(false)
  const [draft, setDraft] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [attachments, setAttachments] = useState<string[]>([])
  const slashCommands = useSlashCommands(cwd)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Auto-scroll to bottom whenever items or the streaming tail change.
  // Why: scrollIntoView() scrolls EVERY scrollable ancestor (it shifted the
  // whole window layout); setting scrollTop only moves the message list.
  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [state.items, state.stream])

  const handleSubmit = (): void => {
    const text = draft.trim()
    if (!text || state.running) {
      return
    }
    sendMessage(text, {
      // 'default' is a sentinel: Radix Select forbids empty-string item values.
      model: model && model !== 'default' ? model : undefined,
      effort: effort && effort !== 'default' ? effort : undefined,
      attachments: attachments.length > 0 ? attachments : undefined
    })
    setDraft('')
    setAttachments([])
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  // Slash command autocomplete: active while the draft is "/query" with no space yet.
  const slashQuery =
    draft.startsWith('/') && !draft.includes(' ') && !draft.includes('\n')
      ? draft.slice(1)
      : null
  const slashMatches =
    slashQuery !== null ? filterSlashCommands(slashCommands, slashQuery) : []

  const pickSlashCommand = (name: string): void => {
    setDraft(`/${name} `)
    textareaRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Tab/Enter completes the highlighted slash command instead of sending.
    if (slashMatches.length > 0 && (e.key === 'Tab' || e.key === 'Enter') && !e.shiftKey) {
      e.preventDefault()
      pickSlashCommand(slashMatches[0].name)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setDraft(e.target.value)
    // Auto-grow textarea, capped at ~6 lines.
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }

  const handleAttachClick = (): void => {
    fileInputRef.current?.click()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(e.target.files ?? []) as ElectronFile[]
    const paths = files.map((f) => f.path).filter(Boolean)
    setAttachments((prev) => [...prev, ...paths])
    // Reset so the same file can be re-selected if needed.
    e.target.value = ''
  }

  const removeAttachment = (path: string): void => {
    setAttachments((prev) => prev.filter((p) => p !== path))
  }

  if (!worktreeId) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground">
        Open a worktree to chat with Claude Code.
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Header toolbar */}
      <div className="shrink-0 border-b border-border px-2 py-1.5 flex items-center gap-1.5">
        {/* Model selector — sourced dynamically from Claude Code local data */}
        <ClaudeChatModelSelect
          value={model}
          onValueChange={setModel}
          activeModel={state.activeModel}
        />

        {/* Effort selector */}
        <Select value={effort} onValueChange={setEffort}>
          <SelectTrigger
            size="sm"
            className="h-6 px-2 text-xs gap-1 border-0 bg-transparent shadow-none hover:bg-accent focus-visible:ring-0 focus-visible:border-0 w-auto"
            aria-label="Effort"
          >
            <SelectValue placeholder="Effort" />
          </SelectTrigger>
          {/* Why: popper keeps the menu below the trigger; the item-aligned default
              closes on the opening click's mouseup (menu overlays the trigger). */}
          <SelectContent position="popper">
            <SelectItem value="default">Default</SelectItem>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="xhigh">XHigh</SelectItem>
            <SelectItem value="max">Max</SelectItem>
          </SelectContent>
        </Select>

        {/* MCP popover */}
        <ChatMcpPopover cwd={cwd} />

        {/* Spacer pushes history/new-chat buttons to the right */}
        <div className="flex-1" />

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setShowHistory((v) => !v)}
          aria-label="Session history"
          className={cn('h-6 w-6', showHistory && 'bg-accent')}
        >
          <History size={13} />
        </Button>

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            newChat()
            setShowHistory(false)
          }}
          aria-label="New chat"
          className="h-6 w-6"
        >
          <SquarePen size={13} />
        </Button>
      </div>

      {/* Message list / history view */}
      {showHistory && cwd ? (
        <ClaudeChatHistoryView
          cwd={cwd}
          onSelect={(sessionId) => {
            void loadSession(sessionId).then(() => setShowHistory(false))
          }}
        />
      ) : (
        <div
          ref={scrollRef}
          className="flex flex-col flex-1 min-h-0 overflow-y-auto scrollbar-sleek px-3 py-3 gap-3"
        >
          {state.items.length === 0 && (
            <p className="text-center text-xs text-muted-foreground pt-4">
              Ask Claude Code anything about this worktree.
            </p>
          )}
          {pairCheckpoints(state.items).map(({ item, checkpoint }) => (
            <ChatMessageItem
              key={item.id}
              item={item}
              checkpoint={checkpoint}
              cwd={cwd}
              onCheckpointReverted={handleCheckpointReverted}
            />
          ))}
          {/* Live partial text / thinking while Claude is generating, or typing dots. */}
          <ChatStreamTail
            running={state.running}
            stream={state.stream}
            activity={state.activity}
          />
        </div>
      )}

      {/* Token usage footer */}
      {state.usage && !showHistory && <ChatUsageBar usage={state.usage} />}

      {/* Input row */}
      <div className="shrink-0 border-t border-border px-2 py-2 flex flex-col gap-1.5">
        {/* Slash command autocomplete */}
        {slashMatches.length > 0 && (
          <ChatSlashMenu matches={slashMatches} onPick={pickSlashCommand} />
        )}
        {/* Attachment chips */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1 px-1">
            {attachments.map((path) => (
              <span
                key={path}
                className="inline-flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-[11px] text-accent-foreground max-w-[180px]"
              >
                <span className="truncate">{basenameOf(path)}</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(path)}
                  className="shrink-0 opacity-60 hover:opacity-100"
                  aria-label={`Remove ${basenameOf(path)}`}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex items-end gap-1.5">
          {/* Hidden file input — Why: no renderer-accessible showOpenDialog API
              exists in this app's preload; Electron File objects in the renderer
              expose a non-standard .path property with the absolute path. */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileChange}
          />

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleAttachClick}
            aria-label="Attach files"
            className="shrink-0"
            disabled={state.running}
          >
            <Paperclip size={16} />
          </Button>

          <textarea
            ref={textareaRef}
            rows={1}
            className={cn(
              'flex-1 min-w-0 resize-none overflow-hidden rounded-md border border-input bg-transparent px-3 py-2 text-sm',
              'placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
              'transition-[color,box-shadow] disabled:opacity-50'
            )}
            placeholder="Message Claude Code… (Enter to send)"
            value={draft}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            disabled={state.running}
          />
          {state.running ? (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={stop}
              aria-label="Stop"
              className="text-destructive hover:text-destructive shrink-0"
            >
              <StopCircle size={16} />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleSubmit}
              disabled={!draft.trim()}
              aria-label="Send"
              className="shrink-0"
            >
              <Send size={16} />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

import React, { useState } from 'react'
import { Loader2, Pencil, X } from 'lucide-react'
import type {
  CloudOfflineChat,
  CloudQueuedPrompt
} from '../../../../../shared/hosted-sandbox/cloud-workspace-offline-api'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'

// The asleep view's chat: the cached transcript, prompts queued to it, and a composer that queues.
function QueuedPromptRow({
  prompt,
  onCancel,
  onEdit
}: {
  prompt: CloudQueuedPrompt
  onCancel: (id: string) => void
  onEdit: (id: string, text: string) => Promise<boolean>
}): React.JSX.Element {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(prompt.text)
  const label = {
    queued: t('components.orcaCloud.offline.queued', 'Queued · sends when the workspace wakes'),
    sending: t('components.orcaCloud.offline.sending', 'Delivering…'),
    delivered: t('components.orcaCloud.offline.delivered', 'Delivered'),
    failed: t('components.orcaCloud.offline.failed', 'Not delivered')
  }[prompt.state]
  return (
    <li
      className="ml-auto flex max-w-[85%] flex-col items-end gap-1"
      data-cloud-queued-prompt={prompt.state}
    >
      {editing ? (
        <div className="flex w-full min-w-72 flex-col gap-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label={t('components.orcaCloud.offline.editQueued', 'Edit queued message')}
            className="min-h-16 text-sm"
          />
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
              {t('components.orcaCloud.offline.cancelEdit', 'Cancel')}
            </Button>
            <Button
              size="xs"
              disabled={!draft.trim()}
              onClick={() =>
                void onEdit(prompt.id, draft).then((saved) => saved && setEditing(false))
              }
            >
              {t('components.orcaCloud.offline.saveEdit', 'Save')}
            </Button>
          </div>
        </div>
      ) : (
        <div
          className={cn(
            'whitespace-pre-wrap rounded-lg border border-dashed px-3 py-2 text-sm',
            prompt.state === 'failed'
              ? 'border-destructive/50 text-foreground'
              : 'border-border bg-muted/40 text-foreground'
          )}
        >
          {prompt.text}
        </div>
      )}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {prompt.state === 'sending' ? (
          <Loader2 className="size-3 motion-safe:animate-spin" />
        ) : null}
        <span className={prompt.state === 'failed' ? 'text-destructive' : undefined}>
          {label}
          {prompt.error ? ` · ${prompt.error}` : ''}
        </span>
        {prompt.state === 'queued' && !editing ? (
          <>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={t('components.orcaCloud.offline.edit', 'Edit')}
              onClick={() => {
                setDraft(prompt.text)
                setEditing(true)
              }}
            >
              <Pencil />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={t('components.orcaCloud.offline.remove', 'Remove from queue')}
              onClick={() => onCancel(prompt.id)}
            >
              <X />
            </Button>
          </>
        ) : null}
      </div>
    </li>
  )
}

export function ChatPanel({
  chats,
  queued,
  onQueue,
  onCancel,
  onEdit
}: {
  chats: CloudOfflineChat[]
  queued: CloudQueuedPrompt[]
  onQueue: (sessionId: string, text: string) => Promise<boolean>
  onCancel: (id: string) => void
  onEdit: (id: string, text: string) => Promise<boolean>
}): React.JSX.Element {
  const t = useTranslate()
  const [selected, setSelected] = useState<string | null>(chats[0]?.sessionId ?? null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const chat = chats.find((candidate) => candidate.sessionId === selected) ?? chats[0]
  if (!chat) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {t('components.orcaCloud.offline.noChats', 'No chats were open in this workspace.')}
      </p>
    )
  }
  const send = (): void => {
    const text = draft.trim()
    if (!text || busy) {
      return
    }
    setBusy(true)
    void onQueue(chat.sessionId, text).then((queuedOk) => {
      setBusy(false)
      if (queuedOk) {
        setDraft('')
      }
    })
  }
  const mine = queued.filter((prompt) => prompt.sessionId === chat.sessionId)
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {chats.length > 1 ? (
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label={t('components.orcaCloud.offline.chats', 'Chats')}
        >
          {chats.map((candidate, index) => (
            <Button
              key={candidate.sessionId}
              size="xs"
              variant={candidate.sessionId === chat.sessionId ? 'secondary' : 'ghost'}
              aria-pressed={candidate.sessionId === chat.sessionId}
              onClick={() => setSelected(candidate.sessionId)}
            >
              {candidate.messages.find((m) => m.role === 'user')?.text.slice(0, 40) ??
                t('components.orcaCloud.offline.chatN', 'Chat {{n}}', { n: index + 1 })}
            </Button>
          ))}
        </div>
      ) : null}
      <ol
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto scrollbar-sleek pr-1"
        aria-live="polite"
      >
        {chat.messages.map((message) => (
          <li
            key={message.itemId}
            className={cn(
              'whitespace-pre-wrap text-sm leading-relaxed',
              message.role === 'user'
                ? 'ml-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 text-foreground'
                : 'max-w-[95%] text-foreground/90'
            )}
          >
            {message.text}
          </li>
        ))}
        {mine.map((prompt) => (
          <QueuedPromptRow key={prompt.id} prompt={prompt} onCancel={onCancel} onEdit={onEdit} />
        ))}
      </ol>
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-background p-2">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              send()
            }
          }}
          placeholder={t(
            'components.orcaCloud.offline.composer',
            'Message the agent. Sending wakes the workspace.'
          )}
          aria-label={t('components.orcaCloud.offline.composerLabel', 'Message to queue')}
          className="min-h-14 resize-none border-0 bg-transparent p-1 text-sm shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {t(
              'components.orcaCloud.offline.composerHint',
              'Delivered as soon as the agent is back.'
            )}
          </span>
          <Button size="xs" disabled={!draft.trim() || busy} onClick={send}>
            {busy ? <Loader2 className="motion-safe:animate-spin" /> : null}
            {t('components.orcaCloud.offline.sendAndWake', 'Send and wake')}
          </Button>
        </div>
      </div>
    </div>
  )
}

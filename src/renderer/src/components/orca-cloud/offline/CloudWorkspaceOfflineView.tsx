import React, { useMemo, useState } from 'react'
import { GitBranch, Loader2, Moon, Pencil, SquareTerminal, X } from 'lucide-react'
import type {
  CloudOfflineChat,
  CloudOfflineSnapshot,
  CloudQueuedPrompt
} from '../../../../../shared/hosted-sandbox/cloud-workspace-offline-api'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'

export type CloudOfflineViewProps = {
  snapshot: CloudOfflineSnapshot
  queued: CloudQueuedPrompt[]
  waking: boolean
  now: number
  onWake: () => void
  onQueue: (sessionId: string, text: string) => Promise<boolean>
  onCancel: (id: string) => void
  onEdit: (id: string, text: string) => Promise<boolean>
}

function relative(at: number, now: number, locale?: string): string {
  const seconds = Math.round((at - now) / 1000)
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const abs = Math.abs(seconds)
  if (abs < 60) {
    return format.format(seconds, 'second')
  }
  if (abs < 3600) {
    return format.format(Math.round(seconds / 60), 'minute')
  }
  if (abs < 86_400) {
    return format.format(Math.round(seconds / 3600), 'hour')
  }
  return format.format(Math.round(seconds / 86_400), 'day')
}

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

function ChatPanel({
  chats,
  queued,
  onQueue,
  onCancel,
  onEdit
}: {
  chats: CloudOfflineChat[]
  queued: CloudQueuedPrompt[]
  onQueue: CloudOfflineViewProps['onQueue']
  onCancel: CloudOfflineViewProps['onCancel']
  onEdit: CloudOfflineViewProps['onEdit']
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

/** A sleeping Orca Cloud workspace, browsable from the client cache without waking it. */
export function CloudWorkspaceOfflineView(props: CloudOfflineViewProps): React.JSX.Element {
  const t = useTranslate()
  const { snapshot, now } = props
  const changeCount = snapshot.git?.changeCount ?? 0
  const defaultTab =
    snapshot.chats.length > 0 ? 'chat' : snapshot.terminals.length > 0 ? 'terminals' : 'changes'
  const empty = snapshot.capturedAt === null
  const captured = useMemo(
    () => (snapshot.capturedAt === null ? null : relative(snapshot.capturedAt, now)),
    [snapshot.capturedAt, now]
  )
  return (
    <section
      className="flex h-full min-h-0 w-full max-w-3xl flex-col gap-4 px-6 py-6"
      aria-label={t('components.orcaCloud.offline.region', 'Sleeping workspace (read-only)')}
      data-cloud-offline-view=""
    >
      <header className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            {props.waking ? (
              <Loader2 className="size-4 motion-safe:animate-spin" />
            ) : (
              <Moon className="size-4" />
            )}
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-foreground">
              {props.waking
                ? t('components.orcaCloud.offline.waking', 'Waking…')
                : t('components.orcaCloud.offline.asleep', 'This workspace is asleep')}
            </h2>
            <p className="text-xs text-muted-foreground">
              {captured
                ? t(
                    'components.orcaCloud.offline.capturedAt',
                    'Read-only copy from {{when}}, kept on this computer.',
                    { when: captured }
                  )
                : t('components.orcaCloud.offline.nothingCached', 'Nothing cached yet.')}
            </p>
          </div>
        </div>
        <Button size="sm" onClick={props.onWake} disabled={props.waking}>
          {props.waking ? <Loader2 className="motion-safe:animate-spin" /> : null}
          {t('components.orcaCloud.offline.wake', 'Wake')}
        </Button>
      </header>
      {empty ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {t(
            'components.orcaCloud.offline.emptyBody',
            'Orca keeps a copy of chats, terminals and changes once you have used this workspace while it was awake.'
          )}
        </p>
      ) : (
        <Tabs defaultValue={defaultTab} className="flex min-h-0 flex-1 flex-col">
          <TabsList>
            <TabsTrigger value="chat">
              {t('components.orcaCloud.offline.tabChat', 'Chat')}
              {snapshot.chats.length > 0 ? (
                <span className="text-muted-foreground">{snapshot.chats.length}</span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="terminals">
              {t('components.orcaCloud.offline.tabTerminals', 'Terminals')}
              {snapshot.terminals.length > 0 ? (
                <span className="text-muted-foreground">{snapshot.terminals.length}</span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="changes">
              {t('components.orcaCloud.offline.tabChanges', 'Changes')}
              {changeCount > 0 ? (
                <span className="text-muted-foreground">{changeCount}</span>
              ) : null}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="chat" className="flex min-h-0 flex-1 flex-col pt-3">
            <ChatPanel
              chats={snapshot.chats}
              queued={props.queued}
              onQueue={props.onQueue}
              onCancel={props.onCancel}
              onEdit={props.onEdit}
            />
          </TabsContent>
          <TabsContent
            value="terminals"
            className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek pt-3"
          >
            {snapshot.terminals.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t('components.orcaCloud.offline.noTerminals', 'No terminal output was saved.')}
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {snapshot.terminals.map((terminal) => (
                  <figure
                    key={terminal.handle}
                    className="overflow-hidden rounded-lg border border-border"
                  >
                    <figcaption className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                      <SquareTerminal className="size-3.5" />
                      <span className="truncate">{terminal.title ?? terminal.handle}</span>
                      <span className="ml-auto">
                        {t('components.orcaCloud.offline.readOnly', 'Read-only')}
                      </span>
                    </figcaption>
                    <pre
                      className="max-h-72 overflow-auto scrollbar-sleek bg-background px-3 py-2 font-mono text-xs leading-5 text-foreground/90"
                      tabIndex={0}
                    >
                      {terminal.lines.join('\n')}
                    </pre>
                  </figure>
                ))}
              </div>
            )}
          </TabsContent>
          <TabsContent
            value="changes"
            className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek pt-3"
          >
            {snapshot.git ? (
              <div className="flex flex-col gap-4 text-sm">
                <div className="flex items-center gap-2 text-foreground">
                  <GitBranch className="size-4 text-muted-foreground" />
                  <span className="font-medium">
                    {snapshot.git.branch ?? t('components.orcaCloud.offline.detached', 'Detached')}
                  </span>
                  {snapshot.git.head ? (
                    <code className="text-xs text-muted-foreground">
                      {snapshot.git.head.slice(0, 7)}
                    </code>
                  ) : null}
                </div>
                <div>
                  <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t('components.orcaCloud.offline.uncommitted', 'Uncommitted changes')}
                  </h3>
                  {snapshot.git.changes.length === 0 ? (
                    <p className="text-muted-foreground">
                      {t('components.orcaCloud.offline.clean', 'Working tree clean.')}
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-0.5 font-mono text-xs">
                      {snapshot.git.changes.map((change) => (
                        <li key={`${change.area}:${change.path}`} className="flex gap-2">
                          <span className="w-16 shrink-0 text-muted-foreground">
                            {change.status}
                          </span>
                          <span className="truncate">{change.path}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t('components.orcaCloud.offline.recentCommits', 'Recent commits')}
                  </h3>
                  <ul className="flex flex-col gap-1">
                    {snapshot.git.commits.map((commit) => (
                      <li key={commit.id} className="flex gap-2">
                        <code className="shrink-0 text-xs text-muted-foreground">
                          {commit.id.slice(0, 7)}
                        </code>
                        <span className="truncate">{commit.subject}</span>
                        {commit.at ? (
                          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                            {relative(commit.at, now)}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t('components.orcaCloud.offline.noGit', 'No source control state was saved.')}
              </p>
            )}
          </TabsContent>
        </Tabs>
      )}
    </section>
  )
}

import { useState } from 'react'
import { ArrowRight, LoaderCircle, X } from 'lucide-react'
import { VisuallyHidden } from 'radix-ui'

import { CommentMarkdownAsync } from '@/components/sidebar/comment-markdown-lazy'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import type {
  PluginTaskItem,
  PluginTaskItemDetail
} from '../../../../../shared/plugins/plugin-task-source-contract'
import type { PluginTaskSourceLoadError } from '@/store/slices/plugin-task-sources-slice-contract'
import { formatRelativeTime } from '../../task-page-source-context'
import { getPluginTaskItemDetailActions } from './item-detail-actions'
import { usePluginTaskItemDetail } from './item-detail-load'
import { TaskPagePluginSourceItemComments } from './ItemDetailComments'
import { getPluginTaskStateTone } from './task-state-tone'
import { usePluginTaskItemWorkspaceSeed } from './workspace-seed'

function unassignedLabel(): string {
  return translate('auto.components.TaskPage.pluginTaskSourceUnassigned', 'Unassigned')
}

function closeLabel(): string {
  return translate('auto.components.TaskPage.pluginTaskSourceDetailClose', 'Close task details')
}

function DetailHeader({
  displayed,
  type,
  loading,
  onStartWorkspace,
  onClose
}: {
  displayed: PluginTaskItem
  type: string | null
  loading: boolean
  onStartWorkspace: () => void
  onClose: () => void
}): React.JSX.Element {
  const startLabel = translate(
    'auto.components.TaskPage.ff90d0abc7',
    'Start workspace from {{value0}}',
    { value0: displayed.key }
  )
  return (
    <div className="flex-none border-b border-border/50 bg-muted/30 px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span className="font-mono">{displayed.key}</span>
            {type ? <span>{type}</span> : null}
            <span>{displayed.assignee?.displayName ?? unassignedLabel()}</span>
            {displayed.updatedAt ? <span>{formatRelativeTime(displayed.updatedAt)}</span> : null}
            {loading ? <LoaderCircle className="size-3 animate-spin" /> : null}
          </div>
          <h2 className="mt-1 text-[20px] leading-tight font-semibold text-foreground">
            {displayed.title}
          </h2>
        </div>
        <Button
          size="sm"
          className="shrink-0"
          onClick={onStartWorkspace}
          aria-label={startLabel}
        >
          {translate('auto.components.TaskPage.9497f2787c', 'Start workspace')}
          <ArrowRight className="size-4" />
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              onClick={onClose}
              aria-label={closeLabel()}
            >
              <X className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {closeLabel()}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

function DetailChips({ displayed }: { displayed: PluginTaskItem }): React.JSX.Element {
  const labels = displayed.labels ?? []
  return (
    <div className="flex-none border-b border-border/60 px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className={cn(
            'inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
            getPluginTaskStateTone(displayed.state.category)
          )}
        >
          <span className="truncate">{displayed.state.name}</span>
        </span>
        <span className="text-[11px] text-muted-foreground">
          {displayed.priority ??
            translate('auto.components.TaskPage.pluginTaskSourceNoPriority', 'No priority')}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {displayed.assignee?.displayName ?? unassignedLabel()}
        </span>
      </div>
      {labels.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {labels.map((label) => (
            <span
              key={label}
              className="max-w-[180px] truncate rounded-full border border-border/50 bg-muted/35 px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              {label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Only a body the source declared as markdown is parsed; `'text'` renders as
 *  literal characters. The contract carries no `'html'` description, so no
 *  third-party markup can reach the DOM. */
function DescriptionBody({ detail }: { detail: PluginTaskItemDetail }): React.JSX.Element {
  const description = detail.description?.trim() ?? ''
  if (description === '') {
    return (
      <p className="text-sm text-muted-foreground italic">
        {translate(
          'auto.components.TaskPage.pluginTaskSourceNoDescription',
          'No description provided.'
        )}
      </p>
    )
  }
  if (detail.descriptionFormat === 'markdown') {
    return (
      <CommentMarkdownAsync
        content={description}
        variant="document"
        className="text-[14px] leading-relaxed"
        fallbackClassName="whitespace-pre-wrap"
      />
    )
  }
  return (
    <p className="text-[14px] leading-relaxed whitespace-pre-wrap text-foreground">{description}</p>
  )
}

function DescriptionSection({
  detail,
  loading,
  error
}: {
  detail: PluginTaskItemDetail | null
  loading: boolean
  error: PluginTaskSourceLoadError | null
}): React.JSX.Element {
  return (
    <section className="border-b border-border/40 px-4 py-4">
      <h3 className="mb-2 text-[13px] font-medium text-foreground">
        {translate('auto.components.TaskPage.pluginTaskSourceDescription', 'Description')}
      </h3>
      {/* A failed load must never read as an item with no description. */}
      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error.message}
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-6">
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : detail ? (
        <DescriptionBody detail={detail} />
      ) : null}
    </section>
  )
}

function DetailActions({
  item,
  sourceTitle
}: {
  item: PluginTaskItem
  sourceTitle: string
}): React.JSX.Element {
  return (
    <aside className="border-t border-border/50 bg-muted/20 px-3 py-3 xl:border-t-0 xl:border-l">
      <div className="grid gap-1">
        {getPluginTaskItemDetailActions(item, sourceTitle).map((entry) => {
          const Icon = entry.icon
          return (
            <button
              key={entry.label}
              type="button"
              onClick={entry.action}
              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition hover:bg-accent hover:text-accent-foreground"
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="truncate">{entry.label}</span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}

function DetailBody({
  item,
  sourceTitle,
  onClose
}: {
  item: PluginTaskItem
  sourceTitle: string
  onClose: () => void
}): React.JSX.Element {
  const state = usePluginTaskItemDetail(item.id)
  const seedWorkspace = usePluginTaskItemWorkspaceSeed()
  const supportsComment = useAppStore((store) => store.pluginTaskSourceSupportsComment)
  const addComment = useAppStore((store) => store.addPluginTaskSourceComment)
  // The row's snapshot stands in until the fetch lands, so the panel opens on
  // what the user clicked instead of an empty frame.
  const displayed: PluginTaskItem = state.detail ?? item
  // Set when a post succeeds but the list is still failing after the retry
  // below, so the composer's "it worked" and the list's "still broken" can
  // both be true on screen at once.
  const [postedWhileListErrored, setPostedWhileListErrored] = useState(false)

  const composer = supportsComment
    ? {
        submit: async (body: string) => {
          const result = await addComment({ itemId: item.id, body })
          if (!result.ok) {
            return result
          }
          if (!state.commentsError) {
            state.appendComment(result.data)
            return result
          }
          // The post landing is good evidence the source is reachable again;
          // retry the list instead of showing one comment under a banner that
          // says the rest of the list is unknown.
          const retry = await state.retryComments()
          if (retry.ok) {
            state.appendComment(result.data)
            setPostedWhileListErrored(false)
          } else {
            setPostedWhileListErrored(true)
          }
          return result
        }
      }
    : null

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <DetailHeader
        displayed={displayed}
        type={state.detail?.type ?? null}
        loading={state.detailLoading}
        onStartWorkspace={() => {
          // The composer opens as a modal over this sheet; leaving the sheet
          // behind it would bury the form the user now has to fill in.
          onClose()
          seedWorkspace(displayed)
        }}
        onClose={onClose}
      />
      <DetailChips displayed={displayed} />
      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_212px]">
        <div className="min-h-0 overflow-y-auto scrollbar-sleek">
          <DescriptionSection
            detail={state.detail}
            loading={state.detailLoading}
            error={state.detailError}
          />
          <TaskPagePluginSourceItemComments
            comments={state.comments}
            loading={state.commentsLoading}
            error={state.commentsError}
            postedWhileErrored={postedWhileListErrored}
            composer={composer}
          />
        </div>
        <DetailActions item={displayed} sourceTitle={sourceTitle} />
      </div>
    </div>
  )
}

/** One contributed task item: its body, its comments, and — only where the
 *  source declared `supports.comment` — a composer. Body and comments are
 *  fetched when it opens; list rows carry neither, by design. */
export function TaskPagePluginSourceItemDetailPanel({
  item,
  sourceTitle,
  onClose
}: {
  item: PluginTaskItem | null
  sourceTitle: string
  onClose: () => void
}): React.JSX.Element {
  return (
    <Sheet
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[min(92vw,780px)] sm:max-w-[780px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>
            {item
              ? `${item.key} ${item.title}`
              : translate('auto.components.TaskPage.pluginTaskSourceDetailTitle', 'Task details')}
          </SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            {translate(
              'auto.components.TaskPage.pluginTaskSourceDetailHint',
              'Read the selected task, its description and its comments.'
            )}
          </SheetDescription>
        </VisuallyHidden.Root>
        {/* Keyed so a second item never shows the first one's body while its
            own request is still in flight. */}
        {item ? (
          <DetailBody key={item.id} item={item} sourceTitle={sourceTitle} onClose={onClose} />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

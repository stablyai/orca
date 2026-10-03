import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { VisuallyHidden } from 'radix-ui'
import { ArrowRight, ChevronDown, ExternalLink, LoaderCircle, X } from 'lucide-react'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
import type {
  YouTrackComment,
  YouTrackIssue,
  YouTrackStateOption
} from '../../../../shared/youtrack-types'
import { YouTrackBlockedBadge, YouTrackStatePill } from './YouTrackIssueList'
import {
  YouTrackCommentComposer,
  YouTrackCommentsSection,
  YouTrackLinksSection
} from './youtrack-issue-sections'
import { startYouTrackIssueWorkspace, useHasYouTrackIssueWorkspace } from './youtrack-workspace'
import { useYouTrackStore } from './youtrack-store'
import { YouTrackFieldsAside } from './YouTrackFieldsAside'

function StatePicker({
  issue,
  onChanged
}: {
  issue: YouTrackIssue
  onChanged: (issue: YouTrackIssue) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<YouTrackStateOption[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const handleOpenChange = (next: boolean): void => {
    setOpen(next)
    if (!next || options || !window.api.youtrack) {
      return
    }
    setLoading(true)
    void window.api.youtrack
      .getStateOptions({ idReadable: issue.idReadable })
      .then((result) => {
        if (result.ok) {
          setOptions(result.options)
        } else {
          toast.error(result.error)
        }
      })
      .finally(() => setLoading(false))
  }

  const choose = async (option: YouTrackStateOption): Promise<void> => {
    if (!window.api.youtrack) {
      return
    }
    setOpen(false)
    setSaving(true)
    const result = await window.api.youtrack.setState({ idReadable: issue.idReadable, option })
    setSaving(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    onChanged(result.issue)
    toast.success(
      translate('youtrack.detail.stateChanged', '{{id}} → {{state}}', {
        id: issue.idReadable,
        state: result.issue.state?.name ?? option.label
      })
    )
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={saving || !issue.stateFieldName}
          className="inline-flex items-center gap-1 rounded-full transition hover:opacity-80 disabled:opacity-50"
          aria-label={translate('youtrack.detail.changeState', 'Change state')}
        >
          {issue.state ? (
            <YouTrackStatePill state={issue.state} />
          ) : (
            <span className="text-[11px] text-muted-foreground">
              {translate('youtrack.detail.noState', 'No state')}
            </span>
          )}
          {saving ? (
            <LoaderCircle className="size-3 animate-spin text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3 text-muted-foreground" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-72 w-56" align="start">
        {loading ? (
          <div className="flex justify-center py-3">
            <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : options && options.length === 0 ? (
          <DropdownMenuLabel>
            {translate('youtrack.detail.noTransitions', 'No available state changes.')}
          </DropdownMenuLabel>
        ) : (
          options?.map((option) => (
            <DropdownMenuItem
              key={`${option.kind}:${option.id}`}
              disabled={option.current}
              onSelect={() => void choose(option)}
              className="justify-between"
            >
              <span className="truncate">{option.label}</span>
              {option.isResolved ? (
                <DropdownMenuShortcut>
                  {translate('youtrack.detail.resolvedState', 'resolves')}
                </DropdownMenuShortcut>
              ) : null}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function YouTrackIssueSheet({
  issueId,
  onClose
}: {
  issueId: string | null
  onClose: () => void
}): React.JSX.Element {
  const listIssue = useYouTrackStore((s) =>
    issueId ? (s.issues.find((issue) => issue.idReadable === issueId) ?? null) : null
  )
  const replaceIssue = useYouTrackStore((s) => s.replaceIssue)
  const selectIssue = useYouTrackStore((s) => s.selectIssue)
  const loadIssues = useYouTrackStore((s) => s.loadIssues)
  const [detail, setDetail] = useState<YouTrackIssue | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [comments, setComments] = useState<YouTrackComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsError, setCommentsError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const requestRef = useRef(0)

  const displayed = detail?.idReadable === issueId ? detail : listIssue

  const loadComments = useCallback((id: string, request: number) => {
    const api = window.api.youtrack
    if (!api) {
      return
    }
    setCommentsLoading(true)
    setCommentsError(null)
    void api
      .getComments({ idReadable: id })
      .then((result) => {
        if (request !== requestRef.current) {
          return
        }
        if (result.ok) {
          setComments(result.comments)
        } else {
          setCommentsError(result.error)
        }
      })
      .finally(() => {
        if (request === requestRef.current) {
          setCommentsLoading(false)
        }
      })
  }, [])

  useEffect(() => {
    const api = window.api.youtrack
    const request = ++requestRef.current
    setComments([])
    setDraft('')
    setDetailError(null)
    if (!issueId || !api) {
      return
    }
    setDetailLoading(true)
    void api
      .getIssue({ idReadable: issueId })
      .then((result) => {
        if (request !== requestRef.current) {
          return
        }
        if (result.ok) {
          setDetail(result.issue)
        } else {
          setDetailError(result.error)
        }
      })
      .finally(() => {
        if (request === requestRef.current) {
          setDetailLoading(false)
        }
      })
    loadComments(issueId, request)
  }, [issueId, loadComments])

  const handleIssueChanged = (issue: YouTrackIssue): void => {
    setDetail(issue)
    replaceIssue(issue)
    // Other rows may show this issue as a blocker, so refetch the list too.
    void loadIssues({ force: true })
  }

  const handleSubmitComment = async (): Promise<void> => {
    const api = window.api.youtrack
    const text = draft.trim()
    if (!displayed || !api || !text || submitting) {
      return
    }
    setSubmitting(true)
    const result = await api.addComment({ idReadable: displayed.idReadable, text })
    setSubmitting(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setComments((prev) => [...prev, result.comment])
    setDraft('')
  }

  const hasLinkedWorkspace = useHasYouTrackIssueWorkspace(displayed?.idReadable ?? null)

  return (
    <Sheet open={issueId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[min(92vw,820px)] sm:max-w-[820px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>
            {displayed?.summary ?? translate('youtrack.detail.title', 'YouTrack issue')}
          </SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            {translate(
              'youtrack.detail.description',
              'Preview, update, and start work from the selected issue.'
            )}
          </SheetDescription>
        </VisuallyHidden.Root>

        {!displayed ? (
          <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
            {detailError ?? <LoaderCircle className="size-5 animate-spin" />}
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
            <div className="flex-none border-b border-border/50 bg-muted/30 px-4 py-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    <span className="font-mono">{displayed.idReadable}</span>
                    <span>{displayed.project.name || displayed.project.shortName}</span>
                    <span>{formatUiRelativeTimeFromDate(displayed.updatedAt)}</span>
                    {detailLoading ? <LoaderCircle className="size-3 animate-spin" /> : null}
                  </div>
                  <h2 className="mt-1 text-[20px] font-semibold leading-tight text-foreground">
                    {displayed.summary}
                  </h2>
                </div>
                <Button
                  onClick={() => startYouTrackIssueWorkspace(displayed)}
                  className="shrink-0"
                  size="sm"
                >
                  {hasLinkedWorkspace
                    ? translate('youtrack.detail.openWorkspace', 'Open workspace')
                    : translate('youtrack.detail.startWorkspace', 'Start workspace')}
                  <ArrowRight className="size-4" />
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0"
                      onClick={() => void window.api.shell.openUrl(displayed.url)}
                      aria-label={translate('youtrack.list.openInYouTrack', 'Open in YouTrack')}
                    >
                      <ExternalLink className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6}>
                    {translate('youtrack.list.openInYouTrack', 'Open in YouTrack')}
                  </TooltipContent>
                </Tooltip>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  onClick={onClose}
                  aria-label={translate('youtrack.detail.close', 'Close')}
                >
                  <X className="size-4" />
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-4 py-2.5">
              <StatePicker
                key={`${displayed.idReadable}:${displayed.state?.name ?? ''}`}
                issue={displayed}
                onChanged={handleIssueChanged}
              />
              <YouTrackBlockedBadge count={displayed.unresolvedBlockerCount} />
              <span className="text-[11px] text-muted-foreground">
                {displayed.assignee?.fullName ??
                  translate('youtrack.list.unassigned', 'Unassigned')}
              </span>
              {displayed.priority ? (
                <span className="text-[11px] text-muted-foreground">{displayed.priority}</span>
              ) : null}
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_228px]">
              <div className="min-h-0 overflow-y-auto scrollbar-sleek">
                <YouTrackLinksSection issue={displayed} onOpenIssue={(id) => selectIssue(id)} />
                <section className="border-b border-border/40 px-4 py-4">
                  {displayed.description?.trim() ? (
                    <CommentMarkdown
                      content={displayed.description}
                      variant="document"
                      className="text-[14px] leading-relaxed"
                    />
                  ) : detailLoading && displayed.description === undefined ? (
                    <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                  ) : (
                    <p className="text-sm italic text-muted-foreground">
                      {translate('youtrack.detail.noDescription', 'No description provided.')}
                    </p>
                  )}
                </section>
                <YouTrackCommentsSection
                  comments={comments}
                  loading={commentsLoading}
                  error={commentsError}
                  onRetry={() => loadComments(displayed.idReadable, requestRef.current)}
                />
              </div>
              <YouTrackFieldsAside issue={displayed} onIssueChanged={handleIssueChanged} />
            </div>

            <YouTrackCommentComposer
              draft={draft}
              setDraft={setDraft}
              submitting={submitting}
              onSubmit={() => void handleSubmitComment()}
            />
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

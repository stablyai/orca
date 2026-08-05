import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react'
import { useAppStore } from '@/store'
import { useActiveWorktree } from '@/store/selectors'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { linearIssueComments } from '@/runtime/runtime-linear-client'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import {
  LinearIssueCommentFooter,
  LinearIssueEditSection,
  initLinearIssueEditState,
  type LinearEditState,
  type LinearLocalComment
} from '@/components/LinearItemDrawer'
import type { LinearComment, LinearIssue } from '../../../../shared/types'
import { getLinearIssueBrowserUrl, getLinearPanelTarget } from './linear-panel-target'

type LinearPanelProps = {
  isVisible?: boolean
}

/**
 * Per-worktree view of the workspace's linked Linear issue. Data comes from the
 * same store cache the sidebar cards use, so opening the panel on an already
 * rendered worktree is usually a cache hit.
 */
export default function LinearPanel({ isVisible = true }: LinearPanelProps): React.JSX.Element {
  const activeWorktree = useActiveWorktree()
  const settings = useAppStore((s) => s.settings)
  const linearStatus = useAppStore((s) => s.linearStatus)
  const fetchLinearIssue = useAppStore((s) => s.fetchLinearIssue)
  const refreshLinearIssue = useAppStore((s) => s.refreshLinearIssue)

  const target = useMemo(() => getLinearPanelTarget(activeWorktree), [activeWorktree])
  const targetKey = target ? `${target.workspaceId}::${target.identifier}` : null

  const [issue, setIssue] = useState<LinearIssue | null>(null)
  const [issueLoading, setIssueLoading] = useState(false)
  const [issueError, setIssueError] = useState<string | null>(null)
  const [comments, setComments] = useState<LinearComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [editState, setEditState] = useState<LinearEditState | null>(null)
  const requestIdRef = useRef(0)
  const hydratedKeyRef = useRef<string | null>(null)
  // Why: a late fetch must not clobber fields the user just edited optimistically.
  const hasEditedRef = useRef(false)
  const optimisticCommentsRef = useRef<LinearComment[]>([])
  const mountedRef = useMountedRef()

  const handleEditStateChange = useCallback((patch: Partial<LinearEditState>) => {
    hasEditedRef.current = true
    setIssue((prev) => (prev ? { ...prev, ...patch } : prev))
    setEditState((prev) => (prev ? { ...prev, ...patch } : prev))
  }, [])

  const handleCommentAdded = useCallback((comment: LinearLocalComment) => {
    const local: LinearComment = {
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt
    }
    optimisticCommentsRef.current = [...optimisticCommentsRef.current, local]
    setComments((prev) => [...prev, local])
  }, [])

  const load = useCallback(
    async (force: boolean): Promise<void> => {
      if (!target) {
        return
      }
      requestIdRef.current += 1
      const requestId = requestIdRef.current
      hasEditedRef.current = false
      if (force) {
        optimisticCommentsRef.current = []
      }
      setIssueLoading(true)
      setIssueError(null)

      const fetched = await (force
        ? refreshLinearIssue(target.identifier, target.workspaceId)
        : fetchLinearIssue(target.identifier, target.workspaceId))
      if (!mountedRef.current || requestId !== requestIdRef.current) {
        return
      }
      if (!fetched) {
        setIssue(null)
        setEditState(null)
        setIssueLoading(false)
        setIssueError(
          translate(
            'auto.components.right.sidebar.LinearPanel.issueUnavailable',
            'Linear issue details unavailable.'
          )
        )
        return
      }
      setIssue(fetched)
      if (!hasEditedRef.current) {
        setEditState(initLinearIssueEditState(fetched))
      }
      setIssueLoading(false)

      // Why: comments are a separate surface; a comments failure must not blank
      // the issue detail that already loaded.
      setCommentsLoading(true)
      try {
        const list = (await linearIssueComments(
          settings,
          fetched.id,
          fetched.workspaceId
        )) as LinearComment[]
        if (!mountedRef.current || requestId !== requestIdRef.current) {
          return
        }
        const optimistic = optimisticCommentsRef.current
        const known = new Set(list.map((comment) => comment.id))
        setComments([...list, ...optimistic.filter((comment) => !known.has(comment.id))])
      } catch {
        /* Keep the issue detail; the comment thread simply stays empty. */
      } finally {
        if (mountedRef.current && requestId === requestIdRef.current) {
          setCommentsLoading(false)
        }
      }
    },
    [fetchLinearIssue, mountedRef, refreshLinearIssue, settings, target]
  )

  // One effect owns hydration so a switch always clears before it fetches.
  // Why the hydrated key: `load` changes identity whenever settings do, and
  // re-running would reset the edit guard and clobber a just-made edit.
  // Why gate on isVisible: panels stay mounted while the sidebar is closed, so
  // an ungated fetch would hit Linear for every worktree the user passes through.
  useEffect(() => {
    if (hydratedKeyRef.current === targetKey) {
      return
    }
    // Drop the previous worktree's issue immediately: showing the old ticket
    // under the new workspace is worse than showing nothing.
    requestIdRef.current += 1
    setIssue(null)
    setEditState(null)
    setComments([])
    setIssueError(null)
    optimisticCommentsRef.current = []

    if (!isVisible || !targetKey) {
      hydratedKeyRef.current = null
      return
    }
    hydratedKeyRef.current = targetKey
    void load(false)
  }, [isVisible, targetKey, load])

  const browserUrl = target ? getLinearIssueBrowserUrl(target, issue?.url) : null

  if (!target) {
    return (
      <PanelMessage>
        {translate(
          'auto.components.right.sidebar.LinearPanel.noLinkedIssue',
          'This workspace has no linked Linear issue.'
        )}
      </PanelMessage>
    )
  }

  if (!linearStatus?.connected) {
    return (
      <PanelMessage>
        {translate(
          'auto.components.right.sidebar.LinearPanel.notConnected',
          'Connect Linear in Settings to see this issue.'
        )}
      </PanelMessage>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[36px] shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <span className="truncate font-mono text-xs text-muted-foreground">
          {target.identifier}
        </span>
        {/* Panel content sits outside the sidebar chrome's provider, so each
            panel supplies its own (matching PortsPanel). */}
        <TooltipProvider delayDuration={400}>
          <div className="ml-auto flex items-center gap-1">
            {browserUrl ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    onClick={() => void window.api.shell.openUrl(browserUrl)}
                  >
                    <ExternalLink size={13} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {translate(
                    'auto.components.right.sidebar.LinearPanel.openInLinear',
                    'Open in Linear'
                  )}
                </TooltipContent>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  disabled={issueLoading}
                  onClick={() => void load(true)}
                >
                  <RefreshCw size={13} className={cn(issueLoading && 'animate-spin')} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {translate('auto.components.right.sidebar.LinearPanel.refresh', 'Refresh')}
              </TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      </div>

      {issueLoading && !issue ? (
        <PanelMessage>
          <LoaderCircle size={14} className="animate-spin" />
        </PanelMessage>
      ) : null}

      {!issue && issueError ? <PanelMessage>{issueError}</PanelMessage> : null}

      {issue && editState ? (
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
          <div className="px-3 py-3">
            <h2 className="text-sm font-semibold leading-snug text-foreground">{issue.title}</h2>
          </div>

          <div className="border-t border-border/60 px-3 py-3">
            <LinearIssueEditSection
              issue={issue}
              editState={editState}
              onEditStateChange={handleEditStateChange}
              layout="properties"
            />
          </div>

          {issue.description ? (
            <div className="border-t border-border/60 px-3 py-3">
              <CommentMarkdown content={issue.description} className="text-[13px] leading-6" />
            </div>
          ) : null}

          <div className="border-t border-border/60 px-3 py-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              {translate('auto.components.right.sidebar.LinearPanel.comments', 'Comments')}
              {commentsLoading ? <LoaderCircle size={12} className="animate-spin" /> : null}
            </div>
            {comments.length > 0 ? (
              <div className="flex flex-col gap-3">
                {comments.map((comment) => (
                  <article key={comment.id} className="min-w-0">
                    <div className="mb-1 flex min-w-0 items-center gap-2 text-xs">
                      <span className="truncate font-medium text-foreground">
                        {comment.user?.displayName ??
                          translate(
                            'auto.components.right.sidebar.LinearPanel.unknownAuthor',
                            'Unknown'
                          )}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {formatUiRelativeTimeFromDate(comment.createdAt)}
                      </span>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-card px-3 py-2">
                      <CommentMarkdown content={comment.body} className="text-[13px] leading-6" />
                    </div>
                  </article>
                ))}
              </div>
            ) : !commentsLoading ? (
              <p className="text-xs text-muted-foreground">
                {translate('auto.components.right.sidebar.LinearPanel.noComments', 'No comments')}
              </p>
            ) : null}

            <div className="mt-3">
              <LinearIssueCommentFooter
                issueId={issue.id}
                workspaceId={issue.workspaceId}
                onCommentAdded={handleCommentAdded}
                variant="compact"
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function PanelMessage({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 px-4 text-center text-xs text-muted-foreground">
      {children}
    </div>
  )
}

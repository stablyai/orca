import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleDot, ExternalLink, GitPullRequest, LoaderCircle, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { useAppStore } from '@/store'
import type { GitHubWorkItemDetails } from '../../../../../shared/types'
import type { GitHubItemDialogProjectOrigin } from '@/components/GitHubItemDialog'
import { LabelsEditor } from './LabelsEditor'
import { AssigneesEditor } from './AssigneesEditor'
import { CommentsList, NewCommentForm } from './Comments'

export function SlugDialogBody({
  projectOrigin,
  onClose
}: {
  projectOrigin: GitHubItemDialogProjectOrigin
  onClose: () => void
}): React.JSX.Element {
  const { owner, repo, number, type, cacheKey } = projectOrigin
  const patchProjectIssueOrPr = useAppStore((s) => s.patchProjectIssueOrPr)
  const projectViewCache = useAppStore((s) => s.projectViewCache)

  // Why: the Project row is the source of truth for the list-side columns;
  // reading it reactively here keeps the dialog in sync with optimistic
  // patches applied by the table (e.g. inline assignee edits).
  const row = useMemo(() => {
    const table = projectViewCache[cacheKey]?.data
    if (!table) {return null}
    return table.rows.find(
      (r) => r.content.number === number && r.content.repository?.toLowerCase() === `${owner}/${repo}`.toLowerCase()
    ) ?? null
  }, [projectViewCache, cacheKey, owner, repo, number])

  const [details, setDetails] = useState<GitHubWorkItemDetails | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  useEffect(() => {
    requestIdRef.current += 1
    const rid = requestIdRef.current
    setLoading(true)
    setError(null)
    setDetails(null)
    window.api.gh
      .projectWorkItemDetailsBySlug({ owner, repo, number, type })
      .then((res) => {
        if (rid !== requestIdRef.current) {return}
        if (res.ok) {
          setDetails(res.details)
        } else {
          setError(res.error.message)
        }
      })
      .catch((err) => {
        if (rid !== requestIdRef.current) {return}
        setError(err instanceof Error ? err.message : 'Failed to load details')
      })
      .finally(() => {
        if (rid !== requestIdRef.current) {return}
        setLoading(false)
      })
  }, [owner, repo, number, type])

  const title = row?.content.title ?? details?.item.title ?? ''
  const url = row?.content.url ?? details?.item.url ?? null
  const Icon = type === 'pr' ? GitPullRequest : CircleDot

  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')

  const commitTitle = useCallback(async () => {
    const next = titleDraft.trim()
    setEditingTitle(false)
    if (!next || next === title) {return}
    // Why: without a row id we can't address the project item — the helper
    // would just return "Row not found" and toast-spam the user. The title
    // button is also disabled in this case (see render below).
    if (!row) {return}
    const res = await patchProjectIssueOrPr(cacheKey, row.id, { title: next })
    if (!res.ok) {toast.error(res.error.message)}
  }, [titleDraft, title, patchProjectIssueOrPr, cacheKey, row])

  const [editingBody, setEditingBody] = useState(false)
  const [bodyDraft, setBodyDraft] = useState('')
  const body = details?.body ?? ''
  const commitBody = useCallback(async () => {
    setEditingBody(false)
    if (bodyDraft === body) {return}
    // Why: same reason as commitTitle — bail rather than ask the helper to
    // patch a missing row. The body button is also disabled when row is null.
    if (!row) {return}
    const res = await patchProjectIssueOrPr(cacheKey, row.id, { body: bodyDraft })
    if (!res.ok) {
      toast.error(res.error.message)
      return
    }
    setDetails((prev) => (prev ? { ...prev, body: bodyDraft } : prev))
  }, [bodyDraft, body, patchProjectIssueOrPr, cacheKey, row])

  const labels = row?.content.labels.map((l) => l.name) ?? []
  const assignees = row?.content.assignees.map((u) => u.login) ?? []

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-none border-b border-border/60 px-4 py-3">
        <div className="flex items-start gap-2">
          <Icon className="mt-1 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="font-mono">
                {owner}/{repo}#{number}
              </span>
            </div>
            {editingTitle ? (
              <Input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => void commitTitle()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void commitTitle()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setEditingTitle(false)
                  }
                }}
                className="mt-1 h-8"
              />
            ) : (
              <button
                type="button"
                disabled={!row}
                className="mt-1 text-left text-[15px] font-semibold leading-tight hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-80"
                onClick={() => {
                  setTitleDraft(title)
                  setEditingTitle(true)
                }}
              >
                {title || 'Untitled'}
              </button>
            )}
          </div>
          <div className="flex items-center gap-1">
            {url ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => void window.api.shell.openUrl(url)}
                aria-label="Open in GitHub"
              >
                <ExternalLink className="size-3.5" />
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onClose}
              aria-label="Close"
            >
              <X className="size-3.5" />
            </Button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px]">
          <LabelsEditor
            owner={owner}
            repo={repo}
            selected={labels}
            disabled={!row}
            onChange={async (add, remove) => {
              // Why: bail rather than call the helper with an empty id —
              // see commitTitle above. Trigger is also disabled when !row.
              if (!row) {return}
              const res = await patchProjectIssueOrPr(cacheKey, row.id, {
                ...(add.length ? { addLabels: add } : {}),
                ...(remove.length ? { removeLabels: remove } : {})
              })
              if (!res.ok) {toast.error(res.error.message)}
            }}
          />
          <AssigneesEditor
            owner={owner}
            repo={repo}
            selected={assignees}
            disabled={!row}
            onChange={async (add, remove) => {
              if (!row) {return}
              const res = await patchProjectIssueOrPr(cacheKey, row.id, {
                ...(add.length ? { addAssignees: add } : {}),
                ...(remove.length ? { removeAssignees: remove } : {})
              })
              if (!res.ok) {toast.error(res.error.message)}
            }}
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        {loading && !details ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" /> Loading…
          </div>
        ) : error ? (
          <div className="text-sm text-destructive">{error}</div>
        ) : details ? (
          <div className="flex flex-col gap-4">
            <section>
              {editingBody ? (
                <div className="flex flex-col gap-2">
                  <textarea
                    autoFocus
                    value={bodyDraft}
                    onChange={(e) => setBodyDraft(e.target.value)}
                    className="min-h-[140px] w-full rounded border border-border/50 bg-background p-2 text-sm"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => void commitBody()}>
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingBody(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : body ? (
                <button
                  type="button"
                  disabled={!row}
                  className="block w-full text-left disabled:cursor-not-allowed"
                  onClick={() => {
                    setBodyDraft(body)
                    setEditingBody(true)
                  }}
                >
                  <CommentMarkdown content={body} variant="document" />
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!row}
                  className="text-xs italic text-muted-foreground hover:underline disabled:cursor-not-allowed disabled:no-underline"
                  onClick={() => {
                    setBodyDraft('')
                    setEditingBody(true)
                  }}
                >
                  Add a description…
                </button>
              )}
            </section>
            <section className="flex flex-col gap-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Comments
              </h3>
              <CommentsList
                owner={owner}
                repo={repo}
                comments={details.comments}
                onChange={(next) => setDetails((d) => (d ? { ...d, comments: next } : d))}
              />
              <NewCommentForm
                owner={owner}
                repo={repo}
                number={number}
                onAdded={(c) =>
                  setDetails((d) => (d ? { ...d, comments: [...d.comments, c] } : d))
                }
              />
            </section>
          </div>
        ) : null}
      </div>
    </div>
  )
}

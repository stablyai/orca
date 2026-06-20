import React, { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Send } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { useRepoSlugIndex } from '@/lib/repo-slug-index'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import type { GlobalSettings, PRComment } from '../../../../../shared/types'
import type {
  GitHubProjectCommentMutationResult,
  GitHubProjectMutationResult
} from '../../../../../shared/github-project-types'
import { translate } from '@/i18n/i18n'

function getRuntimeTarget(settings: Parameters<typeof getActiveRuntimeTarget>[0]) {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment' ? target : null
}

function useRuntimeSettingsForSlug(owner: string, repo: string) {
  const { lookupSlug } = useRepoSlugIndex()
  const matchedRepo = useMemo(
    () => lookupSlug(`${owner}/${repo}`)[0] ?? null,
    [lookupSlug, owner, repo]
  )
  return useAppStore(
    useShallow((s) =>
      matchedRepo ? getSettingsForRepoRuntimeOwner(s, matchedRepo.id) : s.settings
    )
  )
}

export function CommentsList({
  owner,
  repo,
  comments,
  sourceSettings,
  onChange
}: {
  owner: string
  repo: string
  comments: PRComment[]
  sourceSettings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  onChange: (next: PRComment[]) => void
}): React.JSX.Element {
  const fallbackRuntimeSettings = useRuntimeSettingsForSlug(owner, repo)
  const runtimeSettings = sourceSettings ?? fallbackRuntimeSettings
  return (
    <div className="flex flex-col gap-3">
      {comments.length === 0 ? (
        <div className="text-xs italic text-muted-foreground">
          {translate(
            'auto.components.github.project.slug.dialog.Comments.5f104bf855',
            'No comments yet.'
          )}
        </div>
      ) : (
        comments.map((c) => (
          <CommentRow
            key={c.id}
            owner={owner}
            repo={repo}
            comment={c}
            onDelete={async () => {
              const target = getRuntimeTarget(runtimeSettings)
              const args = {
                owner,
                repo,
                commentId: c.id
              }
              const res = target
                ? await callRuntimeRpc<GitHubProjectMutationResult>(
                    target,
                    'github.project.deleteIssueCommentBySlug',
                    args,
                    { timeoutMs: 30_000 }
                  )
                : await window.api.gh.deleteIssueCommentBySlug(args)
              if (!res.ok) {
                toast.error(res.error.message)
                return
              }
              onChange(comments.filter((x) => x.id !== c.id))
            }}
            onEdit={async (next) => {
              const target = getRuntimeTarget(runtimeSettings)
              const args = {
                owner,
                repo,
                commentId: c.id,
                body: next
              }
              const res = target
                ? await callRuntimeRpc<GitHubProjectMutationResult>(
                    target,
                    'github.project.updateIssueCommentBySlug',
                    args,
                    { timeoutMs: 30_000 }
                  )
                : await window.api.gh.updateIssueCommentBySlug(args)
              if (!res.ok) {
                toast.error(res.error.message)
                return
              }
              onChange(comments.map((x) => (x.id === c.id ? { ...x, body: next } : x)))
            }}
          />
        ))
      )}
    </div>
  )
}

function CommentRow({
  comment,
  onDelete,
  onEdit
}: {
  owner: string
  repo: string
  comment: PRComment
  onDelete: () => void | Promise<void>
  onEdit: (next: string) => void | Promise<void>
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(comment.body)
  return (
    <div className="rounded border border-border/50 bg-muted/20 p-3">
      <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{comment.author}</span>
        <div className="flex gap-2">
          <button
            type="button"
            className="hover:underline"
            onClick={() => {
              setDraft(comment.body)
              setEditing(true)
            }}
          >
            {translate('auto.components.github.project.slug.dialog.Comments.8564f58542', 'Edit')}
          </button>
          <button type="button" className="hover:underline" onClick={() => void onDelete()}>
            {translate('auto.components.github.project.slug.dialog.Comments.463d030ae4', 'Delete')}
          </button>
        </div>
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-h-[80px] w-full rounded border border-border/50 bg-background p-2 text-sm"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                setEditing(false)
                void onEdit(draft)
              }}
            >
              {translate('auto.components.github.project.slug.dialog.Comments.c3e829b4d9', 'Save')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {translate(
                'auto.components.github.project.slug.dialog.Comments.c0e576e96b',
                'Cancel'
              )}
            </Button>
          </div>
        </div>
      ) : (
        <CommentMarkdown content={comment.body} />
      )}
    </div>
  )
}

export function NewCommentForm({
  owner,
  repo,
  number,
  sourceSettings,
  onAdded
}: {
  owner: string
  repo: string
  number: number
  sourceSettings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  onAdded: (c: PRComment) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const fallbackRuntimeSettings = useRuntimeSettingsForSlug(owner, repo)
  const runtimeSettings = sourceSettings ?? fallbackRuntimeSettings
  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={translate(
          'auto.components.github.project.slug.dialog.Comments.1c95937c8b',
          'Write a comment…'
        )}
        className="min-h-[80px] w-full rounded border border-border/50 bg-background p-2 text-sm"
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={!draft.trim() || submitting}
          onClick={async () => {
            const body = draft.trim()
            if (!body) {
              return
            }
            setSubmitting(true)
            try {
              const target = getRuntimeTarget(runtimeSettings)
              const args = { owner, repo, number, body }
              const res = target
                ? await callRuntimeRpc<GitHubProjectCommentMutationResult>(
                    target,
                    'github.project.addIssueCommentBySlug',
                    args,
                    { timeoutMs: 30_000 }
                  )
                : await window.api.gh.addIssueCommentBySlug(args)
              if (!res.ok) {
                toast.error(res.error.message)
                return
              }
              onAdded(res.comment)
              setDraft('')
            } finally {
              setSubmitting(false)
            }
          }}
        >
          <Send className="mr-1 size-3.5" />{' '}
          {translate('auto.components.github.project.slug.dialog.Comments.fd5cccd138', 'Comment')}
        </Button>
      </div>
    </div>
  )
}

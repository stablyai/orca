import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import React, { useState } from 'react'
import { Send } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  getCommentBodySubmitState,
  hasBoundedCommentBodyText
} from '@/lib/comment-body-submit-state'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type {
  GitHubProjectCommentMutationResult,
  GitHubProjectMutationResult
} from '../../../../../shared/github/project-result-types'
import { translate } from '@/i18n/i18n'

function getRuntimeTarget(target: RuntimeClientTarget) {
  return target.kind === 'environment' ? target : null
}

export function CommentsList({
  owner,
  repo,
  host,
  comments,
  sourceTarget,
  onChange
}: {
  owner: string
  repo: string
  host?: string
  comments: PRComment[]
  sourceTarget: RuntimeClientTarget
  onChange: (next: PRComment[]) => void
}): React.JSX.Element {
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
              const target = getRuntimeTarget(sourceTarget)
              const args = {
                owner,
                repo,
                ...(host ? { host } : {}),
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
              const target = getRuntimeTarget(sourceTarget)
              const args = {
                owner,
                repo,
                ...(host ? { host } : {}),
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
  host,
  number,
  sourceTarget,
  onAdded
}: {
  owner: string
  repo: string
  host?: string
  number: number
  sourceTarget: RuntimeClientTarget
  onAdded: (c: PRComment) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const canSubmitComment = hasBoundedCommentBodyText(draft)
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
          disabled={!canSubmitComment || submitting}
          onClick={async () => {
            const bodyState = getCommentBodySubmitState(draft)
            if (bodyState.status === 'empty') {
              return
            }
            if (bodyState.status === 'too-large-leading-whitespace') {
              toast.error(
                translate(
                  'auto.components.github.project.slug.dialog.Comments.commentTooLarge',
                  'Comment is too large to submit safely.'
                )
              )
              return
            }
            setSubmitting(true)
            try {
              const target = getRuntimeTarget(sourceTarget)
              const args = {
                owner,
                repo,
                ...(host ? { host } : {}),
                number,
                body: bodyState.body
              }
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

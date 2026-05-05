import React, { useState } from 'react'
import { Send } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import type { PRComment } from '../../../../../shared/types'

export function CommentsList({
  owner,
  repo,
  comments,
  onChange
}: {
  owner: string
  repo: string
  comments: PRComment[]
  onChange: (next: PRComment[]) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {comments.length === 0 ? (
        <div className="text-xs italic text-muted-foreground">No comments yet.</div>
      ) : (
        comments.map((c) => (
          <CommentRow
            key={c.id}
            owner={owner}
            repo={repo}
            comment={c}
            onDelete={async () => {
              const res = await window.api.gh.deleteIssueCommentBySlug({
                owner,
                repo,
                commentId: c.id
              })
              if (!res.ok) {
                toast.error(res.error.message)
                return
              }
              onChange(comments.filter((x) => x.id !== c.id))
            }}
            onEdit={async (next) => {
              const res = await window.api.gh.updateIssueCommentBySlug({
                owner,
                repo,
                commentId: c.id,
                body: next
              })
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
          <button type="button" className="hover:underline" onClick={() => { setDraft(comment.body); setEditing(true) }}>
            Edit
          </button>
          <button type="button" className="hover:underline" onClick={() => void onDelete()}>
            Delete
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
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
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
  onAdded
}: {
  owner: string
  repo: string
  number: number
  onAdded: (c: PRComment) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Write a comment…"
        className="min-h-[80px] w-full rounded border border-border/50 bg-background p-2 text-sm"
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={!draft.trim() || submitting}
          onClick={async () => {
            const body = draft.trim()
            if (!body) {return}
            setSubmitting(true)
            try {
              const res = await window.api.gh.addIssueCommentBySlug({ owner, repo, number, body })
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
          <Send className="mr-1 size-3.5" /> Comment
        </Button>
      </div>
    </div>
  )
}

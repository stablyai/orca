import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronsUpDown, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import {
  getRuntimeRepoBaseRefDefault,
  searchRuntimeRepoBaseRefs
} from '@/runtime/runtime-repo-client'
import type {
  CreateHostedReviewResult,
  HostedReviewCreationEligibility
} from '../../../../shared/hosted-review'
import {
  normalizeHostedReviewBaseRef,
  normalizeHostedReviewHeadRef
} from '../../../../shared/hosted-review-refs'

type CreatePullRequestDialogProps = {
  open: boolean
  repoId: string
  repoPath: string
  branch: string
  eligibility: HostedReviewCreationEligibility | null
  pushBeforeCreate: boolean
  onOpenChange: (open: boolean) => void
  onPushBeforeCreate: () => Promise<boolean>
  onCreated: (result: { number: number; url: string }) => Promise<void>
}

function stripBaseRef(ref: string): string {
  return normalizeHostedReviewBaseRef(ref)
}

function formatCreateError(result: CreateHostedReviewResult, pushed: boolean): string {
  if (result.ok) {
    return ''
  }
  if (pushed) {
    return `Push succeeded, but PR creation failed: ${result.error.replace(/^Create PR failed:\s*/i, '')}`
  }
  return result.error
}

export function CreatePullRequestDialog({
  open,
  repoId,
  repoPath,
  branch,
  eligibility,
  pushBeforeCreate,
  onOpenChange,
  onPushBeforeCreate,
  onCreated
}: CreatePullRequestDialogProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const createHostedReview = useAppStore((s) => s.createHostedReview)
  const submitInFlightRef = useRef(false)
  const initializedFromEligibilityRef = useRef<string | null>(null)
  const [base, setBase] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(false)
  const [baseQuery, setBaseQuery] = useState('')
  const [baseResults, setBaseResults] = useState<string[]>([])
  const [baseSearchError, setBaseSearchError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      submitInFlightRef.current = false
      initializedFromEligibilityRef.current = null
      setSubmitting(false)
      setError(null)
      return
    }
    const initializationKey = `${repoId}:${branch}:${eligibility ? 'ready' : 'pending'}`
    if (initializedFromEligibilityRef.current === initializationKey) {
      return
    }
    // Why: eligibility refreshes while the dialog is open; only seed fields
    // once per branch so late refreshes do not overwrite user edits.
    initializedFromEligibilityRef.current = initializationKey
    const initialBase = eligibility?.defaultBaseRef ?? ''
    setBase(stripBaseRef(initialBase))
    setTitle(eligibility?.title ?? '')
    setBody(eligibility?.body ?? '')
    setDraft(false)
    setBaseQuery('')
    setBaseResults([])
    setBaseSearchError(null)
  }, [branch, eligibility, open, repoId])

  useEffect(() => {
    if (!open || base) {
      return
    }
    let stale = false
    void getRuntimeRepoBaseRefDefault(settings, repoId)
      .then((result) => {
        if (!stale && result.defaultBaseRef) {
          setBase(stripBaseRef(result.defaultBaseRef))
        }
      })
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [base, open, repoId, settings])

  useEffect(() => {
    if (!open || baseQuery.trim().length < 2) {
      setBaseResults([])
      setBaseSearchError(null)
      return
    }
    let stale = false
    const timer = window.setTimeout(() => {
      void searchRuntimeRepoBaseRefs(settings, repoId, baseQuery.trim(), 20)
        .then((results) => {
          if (!stale) {
            setBaseResults(results.map(stripBaseRef))
            setBaseSearchError(null)
          }
        })
        .catch(() => {
          if (!stale) {
            setBaseResults([])
            setBaseSearchError('Branch discovery failed.')
          }
        })
    }, 200)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [baseQuery, open, repoId, settings])

  const submitDisabled =
    submitting ||
    title.trim().length === 0 ||
    base.trim().length === 0 ||
    stripBaseRef(base).toLowerCase() === stripBaseRef(branch).toLowerCase()

  const handleSubmit = useCallback(async (): Promise<void> => {
    if (submitDisabled || submitInFlightRef.current) {
      return
    }
    submitInFlightRef.current = true
    setSubmitting(true)
    setError(null)
    let pushed = false
    try {
      if (pushBeforeCreate) {
        const ok = await onPushBeforeCreate()
        if (!ok) {
          setError('Push failed. Resolve the push error, then try again.')
          return
        }
        pushed = true
      }
      const result = await createHostedReview(repoPath, {
        provider: 'github',
        base: stripBaseRef(base.trim()),
        head: normalizeHostedReviewHeadRef(branch),
        title: title.trim(),
        body,
        draft
      })
      if (result.ok) {
        toast.success(`Pull request #${result.number} created`, {
          action: {
            label: 'Open on GitHub',
            onClick: () => window.api.shell.openUrl(result.url)
          }
        })
        await onCreated(result)
        onOpenChange(false)
        return
      }
      if (result.existingReview?.url) {
        const number = result.existingReview.number
        toast.success(
          number ? `Pull request #${number} is already open` : 'Pull request is already open',
          {
            action: {
              label: 'Open on GitHub',
              onClick: () => window.api.shell.openUrl(result.existingReview!.url)
            }
          }
        )
        if (number) {
          await onCreated({ number, url: result.existingReview.url })
          onOpenChange(false)
          return
        }
      }
      setError(formatCreateError(result, pushed))
    } finally {
      submitInFlightRef.current = false
      setSubmitting(false)
    }
  }, [
    base,
    body,
    branch,
    createHostedReview,
    draft,
    onCreated,
    onOpenChange,
    onPushBeforeCreate,
    pushBeforeCreate,
    repoPath,
    submitDisabled,
    title
  ])

  const handleOpenChange = useCallback(
    (nextOpen: boolean): void => {
      // Why: closing during submit would reset the in-flight guard while the
      // main-process create call can still complete, allowing duplicate clicks.
      if (submitting && !nextOpen) {
        return
      }
      onOpenChange(nextOpen)
    },
    [onOpenChange, submitting]
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Pull Request</DialogTitle>
          <DialogDescription>
            Confirm the target branch and PR details before creating the hosted review.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <Label>Head branch</Label>
            <div className="inline-flex max-w-full items-center rounded-full border border-border bg-muted px-2 py-1 text-xs font-medium text-foreground">
              <span className="truncate">{branch}</span>
            </div>
          </div>

          <div className="space-y-2">
            <div className="space-y-1">
              <Label htmlFor="create-pr-base">Base branch</Label>
              <p className="text-xs text-muted-foreground">
                Search remote branches or enter a branch name.
              </p>
            </div>
            <div className="relative">
              <Input
                id="create-pr-base"
                value={baseQuery || base}
                onChange={(event) => {
                  setBaseQuery(event.target.value)
                  setBase(event.target.value)
                }}
                placeholder="main"
                aria-invalid={!base.trim()}
                className="pr-8"
              />
              <ChevronsUpDown className="pointer-events-none absolute right-2 top-2.5 size-3.5 text-muted-foreground" />
            </div>
            {baseSearchError ? <p className="text-xs text-destructive">{baseSearchError}</p> : null}
            {baseResults.length > 0 ? (
              <div className="max-h-36 overflow-auto rounded-md border border-border p-1 scrollbar-sleek">
                {baseResults.map((ref) => (
                  <button
                    key={ref}
                    type="button"
                    className={cn(
                      'flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent',
                      stripBaseRef(base) === ref && 'bg-accent text-accent-foreground'
                    )}
                    onClick={() => {
                      setBase(ref)
                      setBaseQuery('')
                      setBaseResults([])
                    }}
                  >
                    <span className="truncate">{ref}</span>
                    {stripBaseRef(base) === ref ? <Check className="size-3" /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="create-pr-title">Title</Label>
            <Input
              id="create-pr-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              aria-invalid={!title.trim()}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="create-pr-body">Description</Label>
            <textarea
              id="create-pr-body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={6}
              className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={draft}
              onChange={(event) => setDraft(event.target.checked)}
              className="size-4 rounded border-border accent-primary"
            />
            Draft
          </label>

          {stripBaseRef(base).toLowerCase() === stripBaseRef(branch).toLowerCase() ? (
            <p className="text-xs text-destructive">
              Choose a different base branch before creating a pull request.
            </p>
          ) : null}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={submitDisabled}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {pushBeforeCreate ? 'Push & Create PR' : 'Create PR'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

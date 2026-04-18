import React, { useState } from 'react'
import { ExternalLink, FolderPlus, Github, MessageSquareText, Settings } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import type { GitHubViewer } from '../../../../shared/types'

const GITHUB_ISSUES_URL = 'https://github.com/stablyai/orca/issues/'
const DISCORD_URL = 'https://discord.gg/fzjDKHxv8Q'
const X_URL = 'https://x.com/orca_build'

type SubmitIdentity = {
  githubLogin: string | null
  githubEmail: string | null
}

function openExternalUrl(url: string): void {
  void window.api.shell.openUrl(url)
}

function getSubmitIdentity(viewer: GitHubViewer | null, anonymous: boolean): SubmitIdentity {
  if (anonymous || !viewer) {
    return {
      githubLogin: null,
      githubEmail: null
    }
  }

  return {
    githubLogin: viewer.login,
    githubEmail: viewer.email
  }
}

function FeedbackDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const [feedback, setFeedback] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [viewer, setViewer] = useState<GitHubViewer | null>(null)
  const [isViewerLoading, setIsViewerLoading] = useState(false)
  const [submitAnonymously, setSubmitAnonymously] = useState(false)

  React.useEffect(() => {
    if (!open) {
      return
    }

    let cancelled = false
    setIsViewerLoading(true)
    void window.api.gh
      .viewer()
      .then((nextViewer) => {
        if (!cancelled) {
          setViewer(nextViewer)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setViewer(null)
          console.error('Failed to load GitHub viewer:', err)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsViewerLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [open])

  const handleSubmit = async (): Promise<void> => {
    const trimmed = feedback.trim()
    if (!trimmed) {
      toast.warning('Please enter feedback before submitting.')
      return
    }

    setIsSubmitting(true)
    try {
      const identity = getSubmitIdentity(viewer, submitAnonymously)
      // Why: submission is proxied through the main process via IPC because
      // the packaged Mac build loads the renderer from file://, which makes
      // cross-origin fetch() fail CORS preflight. Electron's net module in
      // the main process has no CORS restrictions and works uniformly in dev
      // and prod.
      const result = await window.api.feedback.submit({
        feedback: trimmed,
        githubLogin: identity.githubLogin,
        githubEmail: identity.githubEmail
      })

      if (!result.ok) {
        throw new Error(`Feedback request failed: ${result.error}`)
      }

      toast.success('Thanks for the feedback.')
      setFeedback('')
      setSubmitAnonymously(false)
      onOpenChange(false)
    } catch (err) {
      toast.error('Failed to submit feedback. Please try again.')
      console.error('Failed to submit feedback:', err)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">Send Feedback</DialogTitle>
          <DialogDescription className="text-xs">
            Share what&apos;s working, what&apos;s broken, or what Orca should do next.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 rounded-md border border-border/70 bg-muted/30 p-3">
          <div className="text-xs font-medium text-foreground">Other ways to reach us</div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => openExternalUrl(GITHUB_ISSUES_URL)}
            >
              <Github className="size-3.5" />
              GitHub issues
              <ExternalLink className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => openExternalUrl(DISCORD_URL)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" className="size-3.5 fill-current">
                <path d="M20.317 4.369A19.791 19.791 0 0 0 15.885 3c-.191.328-.403.77-.553 1.116a18.27 18.27 0 0 0-5.098 0A12.64 12.64 0 0 0 9.68 3a19.736 19.736 0 0 0-4.433 1.369C2.444 8.479 1.69 12.488 2.067 16.44a19.912 19.912 0 0 0 5.427 2.744c.438-.598.828-1.23 1.164-1.89a12.95 12.95 0 0 1-1.833-.877c.154-.113.305-.231.45-.352a14.294 14.294 0 0 0 12.45 0c.146.12.296.239.45.352-.585.34-1.2.634-1.835.878.337.659.727 1.29 1.165 1.888a19.84 19.84 0 0 0 5.43-2.744c.442-4.579-.755-8.551-3.932-12.07ZM9.955 14.005c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.418 2.157-2.418 1.211 0 2.176 1.095 2.157 2.418 0 1.334-.955 2.419-2.157 2.419Zm4.09 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.418 2.157-2.418 1.211 0 2.176 1.095 2.157 2.418 0 1.334-.946 2.419-2.157 2.419Z" />
              </svg>
              Join Discord
              <ExternalLink className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => openExternalUrl(X_URL)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" className="size-3.5 fill-current">
                <path d="M18.901 1.153h3.68l-8.041 9.19L24 22.847h-7.406l-5.8-7.584-6.64 7.584H.474l8.6-9.83L0 1.153h7.594l5.243 6.932 6.064-6.932Zm-1.29 19.493h2.04L6.486 3.24H4.298l13.313 17.406Z" />
              </svg>
              Follow on X
              <ExternalLink className="size-3.5" />
            </Button>
          </div>
        </div>

        <textarea
          autoFocus
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder="What could we improve?"
          rows={7}
          className="min-h-32 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />

        <div className="min-h-9 rounded-md border border-border/70 bg-muted/30 px-3 py-2">
          {viewer ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>
                GitHub:{' '}
                <span className="font-mono text-foreground">
                  {viewer.login}
                  {viewer.email ? ` (${viewer.email})` : ''}
                </span>
              </span>
              <label className="flex cursor-pointer items-center gap-2 text-foreground">
                <input
                  type="checkbox"
                  checked={submitAnonymously}
                  onChange={(event) => setSubmitAnonymously(event.target.checked)}
                  className={cn(
                    'size-3.5 rounded border border-border bg-background align-middle',
                    'accent-foreground'
                  )}
                />
                Submit anonymously
              </label>
            </div>
          ) : isViewerLoading ? (
            <div className="text-xs text-muted-foreground">Checking GitHub identity…</div>
          ) : (
            <div className="text-xs text-muted-foreground">
              Submit with your typed feedback only, or connect `gh` to include GitHub identity.
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={isSubmitting || !feedback.trim()}>
            {isSubmitting ? 'Sending…' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const SidebarToolbar = React.memo(function SidebarToolbar() {
  const openModal = useAppStore((s) => s.openModal)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const [feedbackOpen, setFeedbackOpen] = useState(false)

  return (
    <div className="mt-auto shrink-0">
      <div className="flex items-center justify-between border-t border-sidebar-border px-2 py-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => openModal('add-repo')}
              className="gap-1.5 text-muted-foreground"
            >
              <FolderPlus className="size-3.5" />
              <span className="text-[11px]">Add Repo</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            Open folder picker to add a repo
          </TooltipContent>
        </Tooltip>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setFeedbackOpen(true)}
                className="text-muted-foreground"
              >
                <MessageSquareText className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              Send feedback
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={openSettingsPage}
                className="text-muted-foreground"
              >
                <Settings className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              Settings
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </div>
  )
})

export default SidebarToolbar

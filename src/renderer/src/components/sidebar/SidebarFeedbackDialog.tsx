/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: feedback viewer details are loaded through GitHub IPC after the dialog receives the issue URL. */
import React, { useState } from 'react'
import { ExternalLink, Github } from 'lucide-react'
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
import { useMountedRef } from '@/hooks/useMountedRef'
import { cn } from '@/lib/utils'
import type { GitHubViewer } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

const GITHUB_ISSUES_URL = 'https://github.com/stablyai/orca/issues/'
const DISCORD_URL = 'https://discord.gg/fzjDKHxv8Q'
const X_URL = 'https://x.com/orca_build'

type SubmitIdentity = {
  githubLogin: string | null
  githubEmail: string | null
}

type SidebarFeedbackDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
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

export function SidebarFeedbackDialog({
  open,
  onOpenChange
}: SidebarFeedbackDialogProps): React.JSX.Element {
  const [feedback, setFeedback] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [viewer, setViewer] = useState<GitHubViewer | null>(null)
  const [isViewerLoading, setIsViewerLoading] = useState(false)
  const [submitAnonymously, setSubmitAnonymously] = useState(false)
  const mountedRef = useMountedRef()

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
      toast.warning(
        translate(
          'auto.components.sidebar.SidebarFeedbackDialog.a2fd890d9e',
          'Please enter feedback before submitting.'
        )
      )
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
        submitAnonymously,
        githubLogin: identity.githubLogin,
        githubEmail: identity.githubEmail
      })

      if (!result.ok) {
        throw new Error(`Feedback request failed: ${result.error}`)
      }

      if (mountedRef.current) {
        toast.success(
          translate(
            'auto.components.sidebar.SidebarFeedbackDialog.7a46c228b8',
            'Thanks for the feedback.'
          )
        )
        setFeedback('')
        setSubmitAnonymously(false)
        onOpenChange(false)
      }
    } catch (err) {
      if (mountedRef.current) {
        toast.error(
          translate(
            'auto.components.sidebar.SidebarFeedbackDialog.60b721e857',
            'Failed to submit feedback. Please try again.'
          )
        )
      }
      console.error('Failed to submit feedback:', err)
    } finally {
      if (mountedRef.current) {
        setIsSubmitting(false)
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate('auto.components.sidebar.SidebarFeedbackDialog.0eb643f07f', 'Send Feedback')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.sidebar.SidebarFeedbackDialog.a828fa4aee',
              "Share what's working, what's broken, or what Orca should do next."
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 rounded-md border border-border/70 bg-muted/30 p-3">
          <div className="text-xs font-medium text-foreground">
            {translate(
              'auto.components.sidebar.SidebarFeedbackDialog.9b33530b3d',
              'Other ways to reach us'
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => openExternalUrl(GITHUB_ISSUES_URL)}
            >
              <Github className="size-3.5" />
              {translate(
                'auto.components.sidebar.SidebarFeedbackDialog.d245c4ef6c',
                'GitHub issues'
              )}
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
              {translate(
                'auto.components.sidebar.SidebarFeedbackDialog.26108d3699',
                'Join Discord'
              )}
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
              {translate('auto.components.sidebar.SidebarFeedbackDialog.3460258a54', 'Follow on X')}
              <ExternalLink className="size-3.5" />
            </Button>
          </div>
        </div>

        <textarea
          autoFocus
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder={translate(
            'auto.components.sidebar.SidebarFeedbackDialog.d46ddd66fc',
            'What could we improve?'
          )}
          rows={7}
          className="min-h-32 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />

        <div className="min-h-9 rounded-md border border-border/70 bg-muted/30 px-3 py-2">
          {viewer ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>
                {translate('auto.components.sidebar.SidebarFeedbackDialog.c9e5ea0791', 'GitHub:')}{' '}
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
                {translate(
                  'auto.components.sidebar.SidebarFeedbackDialog.5b120b9634',
                  'Submit anonymously'
                )}
              </label>
            </div>
          ) : isViewerLoading ? (
            <div className="text-xs text-muted-foreground">
              {translate(
                'auto.components.sidebar.SidebarFeedbackDialog.d20439c560',
                'Checking GitHub identity…'
              )}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              {translate(
                'auto.components.sidebar.SidebarFeedbackDialog.8de03e23c5',
                'Submit with your typed feedback only, or connect `gh` to include GitHub identity.'
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {translate('auto.components.sidebar.SidebarFeedbackDialog.8bf619e4cf', 'Cancel')}
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={isSubmitting || !feedback.trim()}>
            {isSubmitting
              ? translate('auto.components.sidebar.SidebarFeedbackDialog.69969ba364', 'Sending…')
              : translate('auto.components.sidebar.SidebarFeedbackDialog.f2e42e1307', 'Send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

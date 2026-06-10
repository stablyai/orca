import React, { useCallback, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
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
import { useAppStore } from '@/store'
import type {
  HostedReviewCreationEligibility,
  HostedReviewProvider
} from '../../../../shared/hosted-review'
import { normalizeHostedReviewHeadRef } from '../../../../shared/hosted-review-refs'
import { stripBaseRef, useCreatePullRequestDialogFields } from './useCreatePullRequestDialogFields'
import {
  DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS,
  resolveSourceControlAiForOperation,
  resolveSourceControlAiPrCreationDefaults
} from '../../../../shared/source-control-ai'
import { getCommitMessageModelDiscoveryHostKeyForScope } from '../../../../shared/commit-message-host-key'
import { getRuntimeGitScope } from '@/runtime/runtime-git-client'
import { CreatePullRequestGenerateButton } from './CreatePullRequestGenerateButton'
import { CreatePullRequestDialogForm } from './CreatePullRequestDialogForm'
import { formatCreateError, reviewCopy } from './create-pull-request-review-copy'
import { translate } from '@/i18n/i18n'

type CreatePullRequestDialogProps = {
  open: boolean
  repoId: string
  repoPath: string
  worktreeId: string | null
  worktreePath: string
  branch: string
  eligibility: HostedReviewCreationEligibility | null
  pushBeforeCreate: boolean
  onOpenChange: (open: boolean) => void
  onPushBeforeCreate: () => Promise<boolean>
  onBranchChangedByGeneration: () => Promise<void>
  onCreated: (result: {
    provider: HostedReviewProvider
    number: number
    url: string
  }) => Promise<void>
}

export function CreatePullRequestDialog({
  open,
  repoId,
  repoPath,
  worktreeId,
  worktreePath,
  branch,
  eligibility,
  pushBeforeCreate,
  onOpenChange,
  onPushBeforeCreate,
  onBranchChangedByGeneration,
  onCreated
}: CreatePullRequestDialogProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const repo = useAppStore((s) => s.repos.find((candidate) => candidate.id === repoId) ?? null)
  const createHostedReview = useAppStore((s) => s.createHostedReview)
  const submitInFlightRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const provider = eligibility?.provider === 'gitlab' ? 'gitlab' : 'github'
  const copy = reviewCopy(provider)
  const prCreationDefaults = React.useMemo(() => {
    if (!settings) {
      return DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS
    }
    const hostKey = getCommitMessageModelDiscoveryHostKeyForScope(
      getRuntimeGitScope(settings, repo?.connectionId)
    )
    const resolved = resolveSourceControlAiForOperation({
      settings,
      repo,
      operation: 'pullRequest',
      discoveryHostKey: hostKey,
      prCreationProductDefaults: DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS
    })
    return resolved.ok
      ? resolved.value.prCreationDefaults
      : resolveSourceControlAiPrCreationDefaults({
          settings,
          repo,
          prCreationProductDefaults: DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS
        })
  }, [repo, settings])
  const {
    aiGenerationEnabled,
    base,
    setBase,
    title,
    setTitle,
    body,
    setBody,
    draft,
    setDraft,
    baseQuery,
    setBaseQuery,
    baseResults,
    setBaseResults,
    baseSearchError,
    generating,
    generateError,
    generateDisabled,
    generateDisabledReason,
    handleGenerate,
    handleCancelGenerate
  } = useCreatePullRequestDialogFields({
    open,
    repoId,
    worktreeId,
    worktreePath,
    branch,
    eligibility,
    repo,
    settings,
    submitting,
    prCreationDefaults,
    onBranchChangedByGeneration
  })

  const resetSubmissionState = useCallback((): void => {
    submitInFlightRef.current = false
    setSubmitting(false)
    setError(null)
  }, [])

  const submitDisabled =
    submitting ||
    generating ||
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
        provider,
        base: stripBaseRef(base.trim()),
        head: normalizeHostedReviewHeadRef(branch),
        title: title.trim(),
        body,
        draft,
        worktreePath,
        useTemplate: prCreationDefaults.useTemplate
      })
      if (result.ok) {
        await onCreated({ provider, number: result.number, url: result.url })
        if (prCreationDefaults.openAfterCreate) {
          window.api.shell.openUrl(result.url)
        }
        resetSubmissionState()
        onOpenChange(false)
        return
      }
      if (result.existingReview?.url) {
        const number = result.existingReview.number
        toast.success(
          number
            ? translate(
                'auto.components.right.sidebar.CreatePullRequestDialog.edc35a7027',
                '{{value0}} #{{value1}} is already open',
                { value0: copy.titleLabel, value1: number }
              )
            : translate(
                'auto.components.right.sidebar.CreatePullRequestDialog.21c7a1daa0',
                '{{value0}} is already open',
                { value0: copy.titleLabel }
              ),
          {
            action: {
              label: translate(
                'auto.components.right.sidebar.CreatePullRequestDialog.7a21f0dae8',
                'Open on {{value0}}',
                { value0: copy.providerName }
              ),
              onClick: () => window.api.shell.openUrl(result.existingReview!.url)
            }
          }
        )
        if (number) {
          await onCreated({ provider, number, url: result.existingReview.url })
          resetSubmissionState()
          onOpenChange(false)
          return
        }
      }
      setError(formatCreateError(result, pushed, copy.shortLabel))
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
    provider,
    pushBeforeCreate,
    copy.providerName,
    copy.shortLabel,
    copy.titleLabel,
    prCreationDefaults.openAfterCreate,
    prCreationDefaults.useTemplate,
    repoPath,
    resetSubmissionState,
    submitDisabled,
    title,
    worktreePath
  ])

  const handleOpenChange = useCallback(
    (nextOpen: boolean): void => {
      // Why: closing during submit would reset the in-flight guard while the
      // main-process create call can still complete, allowing duplicate clicks.
      if (submitting && !nextOpen) {
        return
      }
      if (!nextOpen) {
        resetSubmissionState()
      }
      onOpenChange(nextOpen)
    },
    [onOpenChange, resetSubmissionState, submitting]
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex min-w-0 items-center justify-between gap-2 pr-8">
            <DialogTitle className="min-w-0 truncate">
              {translate(
                'auto.components.right.sidebar.CreatePullRequestDialog.db9cee18f7',
                'Create {{value0}}',
                { value0: copy.titleLabel }
              )}
            </DialogTitle>
            {aiGenerationEnabled ? (
              <CreatePullRequestGenerateButton
                generating={generating}
                generateDisabled={generateDisabled}
                generateDisabledReason={generateDisabledReason}
                shortLabel={copy.shortLabel}
                reviewLabel={copy.reviewLabel}
                onGenerate={() => void handleGenerate()}
                onCancelGenerate={handleCancelGenerate}
              />
            ) : null}
          </div>
          <DialogDescription>
            {translate(
              'auto.components.right.sidebar.CreatePullRequestDialog.f658ff2455',
              'Confirm the target branch and {{value0}} details before creating the hosted review.',
              { value0: copy.shortLabel }
            )}
          </DialogDescription>
        </DialogHeader>

        <CreatePullRequestDialogForm
          branch={branch}
          base={base}
          setBase={setBase}
          baseQuery={baseQuery}
          setBaseQuery={setBaseQuery}
          baseResults={baseResults}
          setBaseResults={setBaseResults}
          baseSearchError={baseSearchError}
          title={title}
          setTitle={setTitle}
          body={body}
          setBody={setBody}
          draft={draft}
          setDraft={setDraft}
          copy={copy}
          generateError={generateError}
          error={error}
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
            {translate(
              'auto.components.right.sidebar.CreatePullRequestDialog.2bc1b4345e',
              'Cancel'
            )}
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={submitDisabled}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {pushBeforeCreate
              ? translate(
                  'auto.components.right.sidebar.CreatePullRequestDialog.a154fe55e6',
                  'Push & Create {{value0}}',
                  { value0: copy.shortLabel }
                )
              : translate(
                  'auto.components.right.sidebar.CreatePullRequestDialog.b7f43474d7',
                  'Create {{value0}}',
                  { value0: copy.shortLabel }
                )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

import React, { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  localizedHostedReviewCopy,
  resolveSupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CreateHostedReviewComposer } from './CreateHostedReviewComposer'
import type { FolderGitTarget } from './folder-source-control-repos'
import type { GitUpstreamStatus } from '../../../../shared/types'
import type { HostedReviewCreationEligibility } from '../../../../shared/hosted-review'

export function FolderSourceControlCreateReviewDialog({
  open,
  onOpenChange,
  target,
  worktreePath,
  branch,
  baseRef,
  upstream,
  onCreated
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: FolderGitTarget
  worktreePath: string
  branch: string | null | undefined
  baseRef: string | undefined
  upstream: GitUpstreamStatus | null | undefined
  onCreated?: () => void
}): React.JSX.Element {
  const getHostedReviewCreationEligibility = useAppStore(
    (state) => state.getHostedReviewCreationEligibility
  )
  const createHostedReview = useAppStore((state) => state.createHostedReview)
  const [eligibility, setEligibility] = useState<HostedReviewCreationEligibility | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [base, setBase] = useState('')
  const [baseQuery, setBaseQuery] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    let stale = false
    setLoading(true)
    setLoadError(null)
    setCreateError(null)
    setCreating(false)
    void getHostedReviewCreationEligibility({
      repoPath: target.repo?.path ?? target.path,
      repoId: target.repo?.id ?? undefined,
      worktreePath,
      connectionId: target.connectionId ?? null,
      branch: branch ?? '',
      base: baseRef,
      hasUncommittedChanges: false,
      hasUpstream: upstream?.hasUpstream,
      ahead: upstream?.ahead,
      behind: upstream?.behind
    })
      .then((result) => {
        if (stale) {
          return
        }
        setEligibility(result)
        if (result.canCreate) {
          setBase(result.defaultBaseRef ?? baseRef ?? '')
          setBaseQuery('')
          setTitle('')
          setBody('')
          setDraft(false)
          return
        }
        const copy = localizedHostedReviewCopy(
          resolveSupportedHostedReviewCopyProvider(result.provider)
        )
        setLoadError(
          translate(
            'auto.components.right.sidebar.source.control.primary.action.f0c6e2a581',
            'This branch is not ready for a {{value0}} yet.',
            { value0: copy.reviewLabel }
          )
        )
      })
      .catch((error: unknown) => {
        if (!stale) {
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      })
      .finally(() => {
        if (!stale) {
          setLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [baseRef, branch, getHostedReviewCreationEligibility, open, target, upstream, worktreePath])

  const handleCreate = useCallback(async () => {
    if (!eligibility || !branch || creating) {
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const result = await createHostedReview(target.repo?.path ?? target.path, {
        repoId: target.repo?.id ?? undefined,
        provider: eligibility.provider,
        base,
        head: branch,
        title,
        body,
        draft,
        worktreePath
      })
      if (result.ok) {
        void window.api.shell.openUrl(result.url)
        onOpenChange(false)
        onCreated?.()
        return
      }
      setCreateError(result.error)
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }, [
    base,
    body,
    branch,
    createHostedReview,
    creating,
    draft,
    eligibility,
    onCreated,
    onOpenChange,
    target.path,
    target.repo,
    title,
    worktreePath
  ])

  const copy = eligibility
    ? localizedHostedReviewCopy(resolveSupportedHostedReviewCopyProvider(eligibility.provider))
    : null

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!creating) {
          onOpenChange(next)
        }
      }}
    >
      <DialogContent className="flex max-h-[min(85vh,36rem)] max-w-xl flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-sm">
            {copy
              ? translate(
                  'auto.components.right.sidebar.SourceControl.e1970d327d',
                  'New {{value0}}',
                  { value0: copy.reviewLabel }
                )
              : translate(
                  'auto.components.right.sidebar.SourceControl.e1970d327d',
                  'New {{value0}}',
                  { value0: '' }
                )}
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto scrollbar-sleek">
          {loading ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.source.control.primary.action.h3i4j5k607',
                'Checking whether this branch can create a {{value0}}…',
                { value0: copy?.reviewLabel ?? '' }
              )}
            </div>
          ) : loadError ? (
            <div className="px-3 py-2 text-xs text-destructive">{loadError}</div>
          ) : eligibility?.canCreate && copy ? (
            <CreateHostedReviewComposer
              provider={eligibility.provider}
              branch={branch ?? ''}
              base={base}
              setBase={setBase}
              title={title}
              setTitle={setTitle}
              body={body}
              setBody={setBody}
              draft={draft}
              setDraft={setDraft}
              baseQuery={baseQuery}
              setBaseQuery={(value) => {
                setBaseQuery(value)
                setBase(value)
              }}
              baseResults={[]}
              setBaseResults={() => {}}
              baseSearchError={null}
              aiGenerationEnabled={false}
              generating={false}
              generateDisabled={false}
              generateError={null}
              createError={createError}
              isCreating={creating}
              primaryAction={{
                disabled: false,
                title: translate(
                  'auto.components.right.sidebar.source.control.primary.action.e7ffa46946',
                  'Create {{value0}}',
                  { value0: copy.shortLabel }
                )
              }}
              onGenerate={() => {}}
              onCancelGenerate={() => {}}
              onPrimaryAction={() => void handleCreate()}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

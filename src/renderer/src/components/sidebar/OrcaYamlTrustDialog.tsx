import React, { useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import type { OrcaHookTrustKind } from '../../../../shared/workspace-setup/hooks/orca-hook-trust-entries'
import { Trans } from 'react-i18next'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'

import {
  getCreatedBranchCopy,
  getAutomationReviewCopy,
  getTitle,
  getDescription,
  getScriptHeading
} from './orca-yaml-trust-copy'

type ScriptKind = OrcaHookTrustKind

const OrcaYamlTrustDialog = React.memo(function OrcaYamlTrustDialog() {
  const t = useTranslate()
  useUiLanguageRevision()
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const markOrcaHookScriptConfirmed = useAppStore((s) => s.markOrcaHookScriptConfirmed)
  const markOrcaHookRepoAlwaysTrusted = useAppStore((s) => s.markOrcaHookRepoAlwaysTrusted)

  const isOpen = activeModal === 'confirm-orca-yaml-hooks'
  const repoId = typeof modalData.repoId === 'string' ? modalData.repoId : ''
  const repoName =
    typeof modalData.repoName === 'string'
      ? modalData.repoName
      : t('auto.components.sidebar.OrcaYamlTrustDialog.thisRepository', 'this repository')
  const scriptKind: ScriptKind =
    modalData.scriptKind === 'archive'
      ? 'archive'
      : modalData.scriptKind === 'issueCommand'
        ? 'issueCommand'
        : modalData.scriptKind === 'vmRecipe'
          ? 'vmRecipe'
          : 'setup'
  const scriptContent = typeof modalData.scriptContent === 'string' ? modalData.scriptContent : ''
  const contentHash = typeof modalData.contentHash === 'string' ? modalData.contentHash : ''
  const versionOnly = modalData.versionOnly === true
  const repoWideTrust = modalData.repoWideTrust === true
  const automation = modalData.automation === true
  const previouslyApproved = versionOnly && modalData.previouslyApproved === true
  const reviewCopy =
    modalData.skippedSetupReview === 'created-branch'
      ? getCreatedBranchCopy(t)
      : modalData.skippedSetupReview === 'automation'
        ? getAutomationReviewCopy(t)
        : null
  const onResolve = typeof modalData.onResolve === 'function' ? modalData.onResolve : null

  const resolveAndClose = useCallback(
    (decision: 'run' | 'trust' | 'skip') => {
      if (decision !== 'skip' && repoId) {
        if (versionOnly && contentHash) {
          markOrcaHookScriptConfirmed(repoId, scriptKind, contentHash)
        }
        if (decision === 'trust') {
          markOrcaHookRepoAlwaysTrusted(repoId)
        }
      }
      onResolve?.(decision)
      closeModal()
    },
    [
      versionOnly,
      closeModal,
      contentHash,
      markOrcaHookRepoAlwaysTrusted,
      markOrcaHookScriptConfirmed,
      onResolve,
      repoId,
      scriptKind
    ]
  )

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        resolveAndClose('skip')
      }
    },
    [resolveAndClose]
  )

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent surface="security" className="max-w-md sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {reviewCopy?.title ?? getTitle(scriptKind, repoName, previouslyApproved, t)}
          </DialogTitle>
          <DialogDescription className="text-xs">
            <Trans
              i18n={i18n}
              defaults={
                reviewCopy?.description ?? getDescription(scriptKind, previouslyApproved, t)
              }
              components={{ code: <code />, repo: <>{repoName}</> }}
            />
          </DialogDescription>
        </DialogHeader>

        {scriptContent && (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2">
            <div className="mb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              {reviewCopy?.heading ?? getScriptHeading(scriptKind, previouslyApproved, t)}
            </div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground scrollbar-sleek">
              {scriptContent}
            </pre>
          </div>
        )}

        {repoWideTrust && (
          <p className="text-xs text-muted-foreground">
            <Trans
              i18n={i18n}
              defaults={t(
                'worktree.setupTrust.alwaysTrustScope',
                'Always trust runs future <code>orca.yaml</code> changes in <repo/> without asking.'
              )}
              components={{ code: <code />, repo: <>{repoName}</> }}
            />
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => resolveAndClose('skip')}>
            {t('auto.components.sidebar.OrcaYamlTrustDialog.43b7bec4cd', "Don't run")}
          </Button>
          {(!automation || versionOnly) && (
            <Button
              variant={repoWideTrust ? 'secondary' : 'default'}
              autoFocus={!repoWideTrust}
              onClick={() => resolveAndClose('run')}
            >
              {versionOnly
                ? t('auto.components.sidebar.OrcaYamlTrustDialog.f3e2b868fb', 'Run hooks')
                : t('worktree.setupTrust.runOnce', 'Run once')}
            </Button>
          )}
          {/* Why: repo-wide trust is ignored for a repo id on several hosts. */}
          {repoWideTrust && (
            <Button autoFocus onClick={() => resolveAndClose('trust')}>
              {t('worktree.setupTrust.alwaysTrust', 'Always trust')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default OrcaYamlTrustDialog

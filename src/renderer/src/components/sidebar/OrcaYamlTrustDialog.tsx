import React, { useCallback, useState } from 'react'
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
import type { OrcaHookScriptKind, OrcaHookTrustUsage } from '@/lib/orca-hook-trust'
import { getOrcaYamlTrustDialogCopy } from './orca-yaml-trust-dialog-copy'
import { Trans } from 'react-i18next'
import { i18n, translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'

type ScriptKind = OrcaHookScriptKind

const OrcaYamlTrustDialog = React.memo(function OrcaYamlTrustDialog() {
  useUiLanguageRevision()
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const markOrcaHookScriptConfirmed = useAppStore((s) => s.markOrcaHookScriptConfirmed)
  const markOrcaHookRepoAlwaysTrusted = useAppStore((s) => s.markOrcaHookRepoAlwaysTrusted)

  const isOpen = activeModal === 'confirm-orca-yaml-hooks'
  const [alwaysTrustState, setAlwaysTrustState] = useState(() => ({
    isOpen,
    value: false
  }))

  // Reset before paint so a new hook prompt never flashes stale Always trust consent.
  if (alwaysTrustState.isOpen !== isOpen) {
    setAlwaysTrustState({ isOpen, value: false })
  }
  const alwaysTrust = alwaysTrustState.isOpen === isOpen ? alwaysTrustState.value : false
  const setAlwaysTrust = (value: boolean): void => {
    setAlwaysTrustState({ isOpen, value })
  }

  const repoId = typeof modalData.repoId === 'string' ? modalData.repoId : ''
  const repoName =
    typeof modalData.repoName === 'string'
      ? modalData.repoName
      : translate('auto.components.sidebar.OrcaYamlTrustDialog.thisRepository', 'this repository')
  const scriptKind: ScriptKind =
    modalData.scriptKind === 'archive'
      ? 'archive'
      : modalData.scriptKind === 'issueCommand'
        ? 'issueCommand'
        : modalData.scriptKind === 'reviewCommand'
          ? 'reviewCommand'
          : modalData.scriptKind === 'vmRecipe'
            ? 'vmRecipe'
            : 'setup'
  const scriptContent = typeof modalData.scriptContent === 'string' ? modalData.scriptContent : ''
  const contentHash = typeof modalData.contentHash === 'string' ? modalData.contentHash : ''
  const previouslyApproved = modalData.previouslyApproved === true
  const usage: OrcaHookTrustUsage = modalData.usage === 'prompt' ? 'prompt' : 'shell'
  const copy = getOrcaYamlTrustDialogCopy(scriptKind, usage, repoName, previouslyApproved)
  const onResolve =
    typeof modalData.onResolve === 'function'
      ? (modalData.onResolve as (decision: 'run' | 'skip') => void)
      : null

  const resolveAndClose = useCallback(
    (decision: 'run' | 'skip') => {
      if (decision === 'run' && repoId) {
        // Repo-wide trust is ignored when the repo id is on two hosts, so keep this script's approval too.
        if (contentHash) {
          markOrcaHookScriptConfirmed(repoId, scriptKind, contentHash)
        }
        if (alwaysTrust) {
          markOrcaHookRepoAlwaysTrusted(repoId)
        }
      }
      onResolve?.(decision)
      closeModal()
    },
    [
      alwaysTrust,
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
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription className="text-xs">
            <Trans
              i18n={i18n}
              defaults={copy.description}
              components={{ code: <code />, repo: <>{repoName}</> }}
            />
          </DialogDescription>
        </DialogHeader>

        {scriptContent && (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {copy.heading}
            </div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground scrollbar-sleek">
              {scriptContent}
            </pre>
          </div>
        )}

        <label
          className={`flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 transition-colors ${
            alwaysTrust
              ? 'border-primary/60 bg-primary/5'
              : 'border-border/70 bg-muted/25 hover:border-border hover:bg-muted/40'
          }`}
        >
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={alwaysTrust}
            onChange={(event) => setAlwaysTrust(event.target.checked)}
          />
          <span className="text-xs font-medium text-foreground">
            <Trans
              i18n={i18n}
              defaults={translate(
                'auto.components.sidebar.OrcaYamlTrustDialog.alwaysTrustRepo',
                'Always trust <code>orca.yaml</code> in <repo/>'
              )}
              components={{ code: <code />, repo: <>{repoName}</> }}
            />
          </span>
        </label>

        <DialogFooter>
          <Button variant="outline" onClick={() => resolveAndClose('skip')}>
            {copy.decline}
          </Button>
          <Button onClick={() => resolveAndClose('run')}>{copy.approve}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default OrcaYamlTrustDialog

import React, { useCallback, useState } from 'react'
import { Trans } from 'react-i18next'
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
import type { OrcaHookScriptKind } from '@/lib/orca-hook-trust'
import { i18n, translate } from '@/i18n/i18n'

type ScriptKind = OrcaHookScriptKind

const SCRIPT_KIND_LABEL: Record<ScriptKind, () => string> = {
  setup: () => translate('orcaYamlTrust.script.setup', 'setup script'),
  archive: () => translate('orcaYamlTrust.script.archive', 'archive script'),
  issueCommand: () => translate('orcaYamlTrust.script.issueCommand', 'issue command'),
  vmRecipe: () => translate('orcaYamlTrust.script.vmRecipe', 'VM recipe')
}

const SCRIPT_KIND_TRIGGER: Record<ScriptKind, () => string> = {
  setup: () => translate('orcaYamlTrust.trigger.setup', 'when this workspace is created'),
  archive: () => translate('orcaYamlTrust.trigger.archive', 'when this workspace is removed'),
  issueCommand: () =>
    translate(
      'orcaYamlTrust.trigger.issueCommand',
      'when this workspace launches with a linked issue'
    ),
  vmRecipe: () => translate('orcaYamlTrust.trigger.vmRecipe', 'before provisioning a VM')
}

const OrcaYamlTrustDialog = React.memo(function OrcaYamlTrustDialog() {
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

  // Why: never show a stale "always trust" choice on a new hook prompt.
  // Resetting during render avoids one paint with the old decision checked.
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
      : translate('orcaYamlTrust.thisRepository', 'this repository')
  const scriptKind: ScriptKind =
    modalData.scriptKind === 'archive'
      ? 'archive'
      : modalData.scriptKind === 'issueCommand'
        ? 'issueCommand'
        : modalData.scriptKind === 'vmRecipe'
          ? 'vmRecipe'
          : 'setup'
  const scriptLabel = SCRIPT_KIND_LABEL[scriptKind]()
  const scriptTrigger = SCRIPT_KIND_TRIGGER[scriptKind]()
  const scriptContent = typeof modalData.scriptContent === 'string' ? modalData.scriptContent : ''
  const contentHash = typeof modalData.contentHash === 'string' ? modalData.contentHash : ''
  const previouslyApproved = modalData.previouslyApproved === true
  const onResolve =
    typeof modalData.onResolve === 'function'
      ? (modalData.onResolve as (decision: 'run' | 'skip') => void)
      : null

  const resolveAndClose = useCallback(
    (decision: 'run' | 'skip') => {
      if (decision === 'run' && repoId) {
        if (alwaysTrust) {
          markOrcaHookRepoAlwaysTrusted(repoId)
        } else if (contentHash) {
          markOrcaHookScriptConfirmed(repoId, scriptKind, contentHash)
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
          <DialogTitle className="text-sm">
            {previouslyApproved
              ? translate(
                  'orcaYamlTrust.changedTitle',
                  '{{script}} changed in {{repository}} — run the new version?',
                  { script: scriptLabel, repository: repoName }
                )
              : translate('orcaYamlTrust.runTitle', 'Run {{script}} from {{repository}}?', {
                  script: scriptLabel,
                  repository: repoName
                })}
          </DialogTitle>
          <DialogDescription className="text-xs">
            <Trans
              i18n={i18n}
              defaults={
                previouslyApproved
                  ? translate(
                      'orcaYamlTrust.changedDescription',
                      '<yaml>orca.yaml</yaml> changed since you last approved it. Review it again before it runs {{trigger}}.'
                    )
                  : translate(
                      'orcaYamlTrust.runDescription',
                      "This repository's <yaml>orca.yaml</yaml> runs on your machine {{trigger}}. Only run it if you trust {{repository}}."
                    )
              }
              values={{ trigger: scriptTrigger, repository: repoName }}
              components={{ yaml: <code /> }}
            />
          </DialogDescription>
        </DialogHeader>

        {scriptContent && (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {previouslyApproved
                ? translate('orcaYamlTrust.newScript', 'New version: {{script}}', {
                    script: scriptLabel
                  })
                : scriptLabel}
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
                'orcaYamlTrust.alwaysTrust',
                'Always trust <yaml>orca.yaml</yaml> in {{repository}}'
              )}
              values={{ repository: repoName }}
              components={{ yaml: <code /> }}
            />
          </span>
        </label>

        <DialogFooter>
          <Button variant="outline" onClick={() => resolveAndClose('skip')}>
            {translate('auto.components.sidebar.OrcaYamlTrustDialog.43b7bec4cd', "Don't run")}
          </Button>
          <Button onClick={() => resolveAndClose('run')}>
            {translate('auto.components.sidebar.OrcaYamlTrustDialog.f3e2b868fb', 'Run hooks')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default OrcaYamlTrustDialog

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
import type { OrcaHookScriptKind } from '@/lib/orca-hook-trust'
import { Trans } from 'react-i18next'
import { i18n, translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'

type ScriptKind = OrcaHookScriptKind

function getTitle(kind: ScriptKind, repoName: string, previouslyApproved: boolean): string {
  const repo = { repo: repoName }
  if (previouslyApproved) {
    switch (kind) {
      case 'setup':
        return translate(
          'auto.components.sidebar.OrcaYamlTrustDialog.setupChangedTitle',
          "{{repo}}'s setup script changed — run the new version?",
          repo
        )
      case 'archive':
        return translate(
          'auto.components.sidebar.OrcaYamlTrustDialog.archiveChangedTitle',
          "{{repo}}'s archive script changed — run the new version?",
          repo
        )
      case 'issueCommand':
        return translate(
          'auto.components.sidebar.OrcaYamlTrustDialog.issueCommandChangedTitle',
          "{{repo}}'s issue command changed — run the new version?",
          repo
        )
      case 'vmRecipe':
        return translate(
          'auto.components.sidebar.OrcaYamlTrustDialog.vmRecipeChangedTitle',
          "{{repo}}'s VM recipe changed — run the new version?",
          repo
        )
    }
  }
  switch (kind) {
    case 'setup':
      return translate(
        'auto.components.sidebar.OrcaYamlTrustDialog.setupRunTitle',
        'Run setup script from {{repo}}?',
        repo
      )
    case 'archive':
      return translate(
        'auto.components.sidebar.OrcaYamlTrustDialog.archiveRunTitle',
        'Run archive script from {{repo}}?',
        repo
      )
    case 'issueCommand':
      return translate(
        'auto.components.sidebar.OrcaYamlTrustDialog.issueCommandRunTitle',
        'Run issue command from {{repo}}?',
        repo
      )
    case 'vmRecipe':
      return translate(
        'auto.components.sidebar.OrcaYamlTrustDialog.vmRecipeRunTitle',
        'Run VM recipe from {{repo}}?',
        repo
      )
  }
}

// Templates embed <code>orca.yaml</code> and a <repo/> slot filled by the component.
function getDescription(kind: ScriptKind, previouslyApproved: boolean): string {
  if (previouslyApproved) {
    switch (kind) {
      case 'setup':
        return translate(
          'auto.components.sidebar.OrcaYamlTrustDialog.setupChangedBody',
          '<code>orca.yaml</code> changed since you last approved. Re-review before it runs when this workspace is created.'
        )
      case 'archive':
        return translate(
          'auto.components.sidebar.OrcaYamlTrustDialog.archiveChangedBody',
          '<code>orca.yaml</code> changed since you last approved. Re-review before it runs when this workspace is removed.'
        )
      case 'issueCommand':
        return translate(
          'auto.components.sidebar.OrcaYamlTrustDialog.issueCommandChangedBody',
          '<code>orca.yaml</code> changed since you last approved. Re-review before it runs when this workspace launches with a linked issue.'
        )
      case 'vmRecipe':
        return translate(
          'auto.components.sidebar.OrcaYamlTrustDialog.vmRecipeChangedBody',
          '<code>orca.yaml</code> changed since you last approved. Re-review before it runs before provisioning a VM.'
        )
    }
  }
  switch (kind) {
    case 'setup':
      return translate(
        'auto.components.sidebar.OrcaYamlTrustDialog.setupRunBody',
        "This repository's <code>orca.yaml</code> runs on your machine when this workspace is created. Only run if you trust <repo/>."
      )
    case 'archive':
      return translate(
        'auto.components.sidebar.OrcaYamlTrustDialog.archiveRunBody',
        "This repository's <code>orca.yaml</code> runs on your machine when this workspace is removed. Only run if you trust <repo/>."
      )
    case 'issueCommand':
      return translate(
        'auto.components.sidebar.OrcaYamlTrustDialog.issueCommandRunBody',
        "This repository's <code>orca.yaml</code> runs on your machine when this workspace launches with a linked issue. Only run if you trust <repo/>."
      )
    case 'vmRecipe':
      return translate(
        'auto.components.sidebar.OrcaYamlTrustDialog.vmRecipeRunBody',
        "This repository's <code>orca.yaml</code> runs on your machine before provisioning a VM. Only run if you trust <repo/>."
      )
  }
}

function getScriptHeading(kind: ScriptKind, previouslyApproved: boolean): string {
  switch (kind) {
    case 'setup':
      return previouslyApproved
        ? translate(
            'auto.components.sidebar.OrcaYamlTrustDialog.newSetupScript',
            'New setup script'
          )
        : translate('auto.components.sidebar.OrcaYamlTrustDialog.setupScript', 'Setup script')
    case 'archive':
      return previouslyApproved
        ? translate(
            'auto.components.sidebar.OrcaYamlTrustDialog.newArchiveScript',
            'New archive script'
          )
        : translate('auto.components.sidebar.OrcaYamlTrustDialog.archiveScript', 'Archive script')
    case 'issueCommand':
      return previouslyApproved
        ? translate(
            'auto.components.sidebar.OrcaYamlTrustDialog.newIssueCommand',
            'New issue command'
          )
        : translate('auto.components.sidebar.OrcaYamlTrustDialog.issueCommand', 'Issue command')
    case 'vmRecipe':
      return previouslyApproved
        ? translate('auto.components.sidebar.OrcaYamlTrustDialog.newVmRecipe', 'New VM recipe')
        : translate('auto.components.sidebar.OrcaYamlTrustDialog.vmRecipe', 'VM recipe')
  }
}

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
        : modalData.scriptKind === 'vmRecipe'
          ? 'vmRecipe'
          : 'setup'
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
            {getTitle(scriptKind, repoName, previouslyApproved)}
          </DialogTitle>
          <DialogDescription className="text-xs">
            <Trans
              i18n={i18n}
              defaults={getDescription(scriptKind, previouslyApproved)}
              components={{ code: <code />, repo: <>{repoName}</> }}
            />
          </DialogDescription>
        </DialogHeader>

        {scriptContent && (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {getScriptHeading(scriptKind, previouslyApproved)}
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

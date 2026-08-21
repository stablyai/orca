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
import type { MCodeHookScriptKind } from '@/lib/mcode-hook-trust'
import { translate } from '@/i18n/i18n'

type ScriptKind = MCodeHookScriptKind

const SCRIPT_KIND_LABEL: Record<ScriptKind, string> = {
  setup: 'setup script',
  archive: 'archive script',
  issueCommand: 'issue command',
  vmRecipe: 'VM recipe'
}

const SCRIPT_KIND_TRIGGER: Record<ScriptKind, string> = {
  setup: 'when this workspace is created',
  archive: 'when this workspace is removed',
  issueCommand: 'when this workspace launches with a linked issue',
  vmRecipe: 'before provisioning a VM'
}

const MCodeYamlTrustDialog = React.memo(function MCodeYamlTrustDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const markMCodeHookScriptConfirmed = useAppStore((s) => s.markMCodeHookScriptConfirmed)
  const markMCodeHookRepoAlwaysTrusted = useAppStore((s) => s.markMCodeHookRepoAlwaysTrusted)

  const isOpen = activeModal === 'confirm-mcode-yaml-hooks'
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
  const repoName = typeof modalData.repoName === 'string' ? modalData.repoName : 'this repository'
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
          markMCodeHookRepoAlwaysTrusted(repoId)
        } else if (contentHash) {
          markMCodeHookScriptConfirmed(repoId, scriptKind, contentHash)
        }
      }
      onResolve?.(decision)
      closeModal()
    },
    [
      alwaysTrust,
      closeModal,
      contentHash,
      markMCodeHookRepoAlwaysTrusted,
      markMCodeHookScriptConfirmed,
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
      <DialogContent className="max-w-md sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {previouslyApproved
              ? translate(
                  'auto.components.sidebar.MCodeYamlTrustDialog.02b0ede5ad',
                  "{{value0}}'s {{value1}} changed — run the new version?",
                  { value0: repoName, value1: SCRIPT_KIND_LABEL[scriptKind] }
                )
              : translate(
                  'auto.components.sidebar.MCodeYamlTrustDialog.e4a51dc4b3',
                  'Run {{value0}} from {{value1}}?',
                  { value0: SCRIPT_KIND_LABEL[scriptKind], value1: repoName }
                )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {previouslyApproved ? (
              <>
                <code>
                  {translate('auto.components.sidebar.MCodeYamlTrustDialog.79afc6772b', 'mcode.yaml')}
                </code>{' '}
                {translate(
                  'auto.components.sidebar.MCodeYamlTrustDialog.c55beddbf8',
                  'changed since you last approved. Re-review before it runs'
                )}{' '}
                {SCRIPT_KIND_TRIGGER[scriptKind]}.
              </>
            ) : (
              <>
                {translate(
                  'auto.components.sidebar.MCodeYamlTrustDialog.aa3ffb33fb',
                  "This repository's"
                )}{' '}
                <code>
                  {translate('auto.components.sidebar.MCodeYamlTrustDialog.79afc6772b', 'mcode.yaml')}
                </code>{' '}
                {translate(
                  'auto.components.sidebar.MCodeYamlTrustDialog.831f2cd9f0',
                  'runs on your machine'
                )}{' '}
                {SCRIPT_KIND_TRIGGER[scriptKind]}
                {translate(
                  'auto.components.sidebar.MCodeYamlTrustDialog.bf800b7e04',
                  '. Only run if you trust'
                )}{' '}
                {repoName}.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {scriptContent && (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {previouslyApproved
                ? translate(
                    'auto.components.sidebar.MCodeYamlTrustDialog.9e52effffd',
                    'New {{value0}} script',
                    { value0: scriptKind }
                  )
                : translate(
                    'auto.components.sidebar.MCodeYamlTrustDialog.95bf974a1a',
                    '{{value0}} script',
                    { value0: scriptKind }
                  )}
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
            {translate('auto.components.sidebar.MCodeYamlTrustDialog.531689199b', 'Always trust')}{' '}
            <code>
              {translate('auto.components.sidebar.MCodeYamlTrustDialog.79afc6772b', 'mcode.yaml')}
            </code>{' '}
            {translate('auto.components.sidebar.MCodeYamlTrustDialog.c494b3ccb1', 'in')} {repoName}
          </span>
        </label>

        <DialogFooter>
          <Button variant="outline" onClick={() => resolveAndClose('skip')}>
            {translate('auto.components.sidebar.MCodeYamlTrustDialog.43b7bec4cd', "Don't run")}
          </Button>
          <Button onClick={() => resolveAndClose('run')}>
            {translate('auto.components.sidebar.MCodeYamlTrustDialog.f3e2b868fb', 'Run hooks')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default MCodeYamlTrustDialog

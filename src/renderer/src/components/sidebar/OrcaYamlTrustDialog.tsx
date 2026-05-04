import React, { useCallback, useEffect, useState } from 'react'
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

type ScriptKind = OrcaHookScriptKind

const SCRIPT_KIND_LABEL: Record<ScriptKind, string> = {
  setup: 'setup script',
  archive: 'archive script',
  issueCommand: 'issue command'
}

const SCRIPT_KIND_TRIGGER: Record<ScriptKind, string> = {
  setup: 'when this workspace is created',
  archive: 'when this workspace is removed',
  issueCommand: 'when this workspace launches with a linked issue'
}

const OrcaYamlTrustDialog = React.memo(function OrcaYamlTrustDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const markOrcaHookScriptConfirmed = useAppStore((s) => s.markOrcaHookScriptConfirmed)
  const markOrcaHookRepoAlwaysTrusted = useAppStore((s) => s.markOrcaHookRepoAlwaysTrusted)
  const [alwaysTrust, setAlwaysTrust] = useState(false)

  const isOpen = activeModal === 'confirm-orca-yaml-hooks'

  const repoId = typeof modalData.repoId === 'string' ? modalData.repoId : ''
  const repoName = typeof modalData.repoName === 'string' ? modalData.repoName : 'this repository'
  const scriptKind: ScriptKind =
    modalData.scriptKind === 'archive'
      ? 'archive'
      : modalData.scriptKind === 'issueCommand'
        ? 'issueCommand'
        : 'setup'
  const scriptContent = typeof modalData.scriptContent === 'string' ? modalData.scriptContent : ''
  const contentHash = typeof modalData.contentHash === 'string' ? modalData.contentHash : ''
  const onResolve =
    typeof modalData.onResolve === 'function'
      ? (modalData.onResolve as (decision: 'run' | 'skip') => void)
      : null

  useEffect(() => {
    if (isOpen) {
      setAlwaysTrust(false)
    }
  }, [isOpen])

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
      <DialogContent className="max-w-md sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            Run {SCRIPT_KIND_LABEL[scriptKind]} from {repoName}?
          </DialogTitle>
          <DialogDescription className="text-xs">
            This repository&apos;s <code>orca.yaml</code> defines a {SCRIPT_KIND_LABEL[scriptKind]}{' '}
            that will execute on your machine {SCRIPT_KIND_TRIGGER[scriptKind]}. Only run it if you
            trust the contents of this repository.
          </DialogDescription>
        </DialogHeader>

        {scriptContent && (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {scriptKind} script
            </div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground">
              {scriptContent}
            </pre>
          </div>
        )}

        <label className="flex items-start gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            className="mt-0.5 h-3.5 w-3.5"
            checked={alwaysTrust}
            onChange={(event) => setAlwaysTrust(event.target.checked)}
          />
          <span>
            Always trust this repository&apos;s <code>orca.yaml</code> hooks.
          </span>
        </label>

        <DialogFooter>
          <Button variant="outline" onClick={() => resolveAndClose('skip')}>
            Don&apos;t run
          </Button>
          <Button onClick={() => resolveAndClose('run')}>Run hooks</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default OrcaYamlTrustDialog

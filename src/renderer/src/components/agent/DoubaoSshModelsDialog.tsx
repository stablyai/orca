import { useEffect, useState } from 'react'
import { List } from 'lucide-react'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { discoverRuntimeCommitMessageModels } from '@/runtime/source-control/git/runtime-git-generation-client'
import type { RuntimeGitContext } from '@/runtime/source-control/git/runtime-git-client-context'
import { resolveWorktreeModelDiscoveryRuntime } from '../native-chat/session/options/catalog/native-chat-session-option-discovery'

function sshWorkspace(state: AppState, worktree: Worktree): RuntimeGitContext | null {
  const hostId = worktree.runtimeOwnerEnvironmentId
    ? toRuntimeExecutionHostId(worktree.runtimeOwnerEnvironmentId)
    : worktree.hostId
  const copy = hostId ? { hostId, path: worktree.path } : undefined
  const context = resolveWorktreeModelDiscoveryRuntime(state, worktree.id, copy)
  return context?.connectionId ? context : null
}

export function DoubaoSshModelsMenuItem({
  worktree,
  onOpen
}: {
  worktree: Worktree
  onOpen: (context: RuntimeGitContext) => void
}) {
  const t = useTranslate()
  const available = useAppStore((state) => Boolean(sshWorkspace(state, worktree)))
  if (!available) {
    return null
  }
  return (
    <DropdownMenuItem
      onSelect={() => {
        const context = sshWorkspace(useAppStore.getState(), worktree)
        if (context) {
          onOpen(context)
        }
      }}
    >
      <List className="size-3.5" />
      {t('agentPicker.doubaoSshModels.action', 'View Doubao models…')}
    </DropdownMenuItem>
  )
}

type Listing =
  | { kind: 'loading' | 'failed' }
  | { kind: 'ready'; models: { id: string; label: string }[] }

export function DoubaoSshModelsDialog({
  workspace,
  onClose
}: {
  workspace: RuntimeGitContext
  onClose: () => void
}) {
  const t = useTranslate()
  const [attempt, setAttempt] = useState(0)
  const [listing, setListing] = useState<Listing>({ kind: 'loading' })
  useEffect(() => {
    const controller = new AbortController()
    void discoverRuntimeCommitMessageModels(workspace, 'doubao', controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) {
          setListing(
            result.success && result.catalogOrigin === 'probe'
              ? { kind: 'ready', models: result.models }
              : { kind: 'failed' }
          )
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setListing({ kind: 'failed' })
        }
      }
    )
    return () => controller.abort()
  }, [workspace, attempt])
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent size="list" scrollable showCloseButton>
        <DialogHeader>
          <DialogTitle>
            {t('agentPicker.doubaoSshModels.title', 'Doubao models on this SSH host')}
          </DialogTitle>
          <DialogDescription className="break-all">{workspace.worktreePath}</DialogDescription>
        </DialogHeader>
        {listing.kind === 'loading' && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoadingSpinner className="size-4" />
            {t('agentPicker.catalogLoading', 'Loading models…')}
          </p>
        )}
        {listing.kind === 'failed' && (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-muted-foreground">
              {t(
                'agentPicker.doubaoSshModels.failed',
                'Couldn’t list Doubao models. Check the SSH connection and the Doubao CLI on this host, then try again.'
              )}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setListing({ kind: 'loading' })
                setAttempt((value) => value + 1)
              }}
            >
              {t('common.retry', 'Retry')}
            </Button>
          </div>
        )}
        {listing.kind === 'ready' &&
          (listing.models.length ? (
            <ul className="divide-y divide-border">
              {listing.models.map((model) => (
                <li key={model.id} className="py-2">
                  <div className="break-words text-sm">{model.label}</div>
                  <code className="break-all text-xs text-muted-foreground">{model.id}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {t('agentPicker.doubaoSshModels.empty', 'The Doubao CLI returned no models.')}
            </p>
          ))}
      </DialogContent>
    </Dialog>
  )
}

import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { OrcadDeltaMovePreview } from '../../../../shared/orcad-managed-runtime'
import type { SshTarget } from '../../../../shared/ssh-types'
import type { ManagedOrcadPreloadApi } from '../../../../preload/api/managed-orcad-api'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { conversionBlockerLabel, managedServerOutcomeLabel } from './managed-server-copy'
import { deltaMoveRowLabel } from './ssh-host-delta-move-copy'

type SshHostDeltaMoveDialogProps = {
  api: ManagedOrcadPreloadApi
  target: SshTarget | null
  onClose: () => void
  onFinished: () => void
}

/** Confirms moving what an older build added, and names what the server will not reflect. */
export function SshHostDeltaMoveDialog({
  api,
  target,
  onClose,
  onFinished
}: SshHostDeltaMoveDialogProps): React.JSX.Element {
  const mountedRef = useMountedRef()
  const [preview, setPreview] = useState<OrcadDeltaMovePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  // Why the id: callers pass a fresh target object on every reload, which must not reset a run.
  const targetId = target?.id ?? null

  useEffect(() => {
    if (!targetId) {
      return
    }
    setPreview(null)
    setError(null)
    setRunning(false)
    api.previewDeltaMove({ sshTargetId: targetId }).then(
      (next) => mountedRef.current && setPreview(next),
      (cause: unknown) => mountedRef.current && setError(messageOf(cause))
    )
  }, [api, mountedRef, targetId])

  const move = async (): Promise<void> => {
    if (!targetId || running) {
      return
    }
    setRunning(true)
    setError(null)
    try {
      const result = await api.moveDelta({ sshTargetId: targetId })
      if (!mountedRef.current) {
        return
      }
      if (result.outcome === 'moved') {
        onFinished()
        onClose()
        return
      }
      setError(
        result.blockers?.map(conversionBlockerLabel).join(' ') || managedServerOutcomeLabel(result)
      )
    } catch (cause) {
      if (mountedRef.current) {
        setError(messageOf(cause))
      }
    } finally {
      if (mountedRef.current) {
        setRunning(false)
      }
    }
  }

  const unreflected = preview
    ? [...preview.notReflected.edited, ...preview.notReflected.removed]
    : []
  const blocked = (preview?.blockers.length ?? 0) > 0
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && !running && onClose()}>
      <DialogContent showCloseButton={!running}>
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.settings.deltaMove.title', 'Move the new projects')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.deltaMove.description',
              'An older version of Orca changed this host after it moved to its managed server. This adds what it created to the server; it never merges over what the server already has.'
            )}
          </DialogDescription>
        </DialogHeader>
        {preview ? (
          <div className="space-y-3 text-sm">
            <section className="space-y-1">
              <p className="font-medium">
                {translate('auto.components.settings.deltaMove.added', 'Added to the server')}
              </p>
              {preview.added.length > 0 ? (
                <ul className="list-disc pl-5 text-muted-foreground">
                  {preview.added.map((row) => (
                    <li key={`${row.kind}:${row.id}`}>{deltaMoveRowLabel(row)}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">
                  {translate(
                    'auto.components.settings.deltaMove.nothingNew',
                    'Nothing new to add.'
                  )}
                </p>
              )}
            </section>
            {unreflected.length > 0 ? (
              <section className="space-y-1">
                <p className="font-medium">
                  {translate(
                    'auto.components.settings.deltaMove.notReflected',
                    'Changed or removed on the older version; the server keeps its own copy'
                  )}
                </p>
                <ul className="list-disc pl-5 text-muted-foreground">
                  {unreflected.map((row) => (
                    <li key={`${row.kind}:${row.id}`}>{deltaMoveRowLabel(row)}</li>
                  ))}
                </ul>
              </section>
            ) : null}
            {preview.blockers.map((blocker) => (
              <p key={blocker.code} className="text-destructive">
                {conversionBlockerLabel(blocker)}
              </p>
            ))}
          </div>
        ) : error ? null : (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        )}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={running}>
            {translate('auto.components.settings.deltaMove.cancel', 'Cancel')}
          </Button>
          <Button
            onClick={() => void move()}
            disabled={running || !preview || preview.added.length === 0 || blocked}
          >
            {running ? <Loader2 className="animate-spin" /> : null}
            {translate('auto.components.settings.deltaMove.confirm', 'Move the new projects')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

import { useState } from 'react'
import { Button } from '../ui/button'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'

export function PerforceConnectionTest(): React.JSX.Element {
  const worktree = useAppStore((s) =>
    s.activeWorktreeId ? (s.getKnownWorktreeById(s.activeWorktreeId) ?? null) : null
  )
  const repo = useAppStore((s) => s.repos.find((r) => r.id === worktree?.repoId))
  const target = worktree ? { worktreePath: worktree.path, connectionId: repo?.connectionId } : null
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const run = async (): Promise<void> => {
    if (!target) {
      return
    }
    setPending(true)
    try {
      const outcome = await window.api.perforce.info({
        worktreePath: target.worktreePath,
        connectionId: target.connectionId ?? undefined
      })
      setFailed(!outcome.success)
      setResult(
        outcome.success
          ? [
              `Server ${outcome.info.port || '—'}`,
              `User ${outcome.info.user || '—'}`,
              `Client ${outcome.info.client || '—'}`,
              `Root ${outcome.info.root || '—'}`
            ].join(' · ')
          : outcome.error
      )
    } catch (error) {
      setFailed(true)
      setResult(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex max-w-md flex-col items-end gap-1">
      <Button size="sm" variant="outline" disabled={!target || pending} onClick={() => void run()}>
        {translate('perforce.settings.test-connection.button', 'Test connection')}
      </Button>
      <p className={failed ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
        {target
          ? (result ?? '')
          : translate(
              'perforce.settings.test-connection.noWorkspace',
              'Open a workspace to test its connection.'
            )}
      </p>
    </div>
  )
}

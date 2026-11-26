import { useState } from 'react'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { useAppStore } from '@/store/index'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useCommanderHostOptions } from './selected-commander-host'
import { handoffWorkspaces, type WorkerHandoffDestination } from './handoff-workspaces'

export function CommanderWorkerResume({
  projectId,
  busy,
  onResume
}: {
  projectId: string
  busy: boolean
  onResume: (destination: WorkerHandoffDestination) => void
}): React.JSX.Element {
  const t = useTranslate()
  const { selected: hostId, live } = useCommanderHostOptions()
  const repos = useAppStore((state) => state.repos)
  const worktrees = useAppStore(selectWorktreesByRepo)
  const candidates = handoffWorkspaces(projectId, hostId, repos, worktrees)
  const [choice, setChoice] = useState<{ hostId: string; id: string } | null>(null)
  const chosen =
    candidates.length === 1
      ? candidates[0]
      : candidates.find((wt) => choice?.hostId === hostId && choice.id === wt.id)
  const available = live.includes(hostId) && !!chosen && !busy
  if (!candidates.length) {
    return (
      <p className="text-xs text-muted-foreground">
        {t(
          'commander.handoffs.checkoutMissing',
          'Open a checkout of this Git project on the selected host to resume in Codex or Claude.'
        )}
      </p>
    )
  }
  return (
    <div className="space-y-2">
      <label className="flex flex-wrap items-center gap-2">
        {t('commander.handoffs.workspace', 'Project workspace')}
        <select
          className="h-8 max-w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-ring"
          disabled={busy}
          value={chosen?.id ?? ''}
          onChange={(e) => setChoice({ hostId, id: e.target.value })}
        >
          {!chosen && (
            <option value="">{t('commander.handoffs.pickWorkspace', 'Choose a checkout')}</option>
          )}
          {candidates.map((wt) => (
            <option key={wt.id} value={wt.id}>
              {wt.path} · {wt.branch || wt.head.slice(0, 12)}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        {(['codex', 'claude'] as const).map((agent) => (
          <Button
            size="sm"
            variant="outline"
            key={agent}
            disabled={!available}
            onClick={() => {
              if (chosen) {
                onResume({ agent, hostId, worktreeId: chosen.id, instanceId: chosen.instanceId })
              }
            }}
          >
            {t('commander.handoffs.workerResume', 'Resume in {{agent}}', {
              agent: agent === 'codex' ? 'Codex' : 'Claude'
            })}
          </Button>
        ))}
      </div>
    </div>
  )
}

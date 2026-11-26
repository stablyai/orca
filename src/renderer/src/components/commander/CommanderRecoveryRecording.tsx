import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import type {
  CommanderAccount,
  CommanderRecoveryStatus
} from '../../../../shared/commander/memory-contract'

export function CommanderRecoveryRecording({
  account
}: {
  account: CommanderAccount
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const id = useId()
  const [status, setStatus] = useState<CommanderRecoveryStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const sequence = useRef(0)
  const writing = useRef(false)
  const update = useCallback(
    async (enabled?: boolean) => {
      if (writing.current) {
        return
      }
      const request = ++sequence.current
      if (enabled !== undefined) {
        writing.current = true
        setSaving(true)
      }
      try {
        const result = await window.api.commanderMemory.agentRecovery(account, enabled)
        if (request === sequence.current) {
          setStatus(result)
          setFailed(false)
        }
      } catch {
        if (request === sequence.current) {
          setFailed(true)
        }
      }
      if (enabled !== undefined) {
        writing.current = false
        if (request === sequence.current) {
          setSaving(false)
        }
      }
    },
    [account]
  )
  useEffect(() => {
    return installWindowVisibilityInterval({
      run: () => void update(),
      intervalMs: 30_000,
      slowWhileUnfocused: true
    })
  }, [update])
  return (
    <div className="space-y-1 rounded-lg border border-border p-3">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <label htmlFor={id} className="block text-sm font-medium">
            {t('commander.recovery.label', 'Save agent handoffs automatically')}
          </label>
          <p id={`${id}-detail`} className="text-xs text-muted-foreground">
            {t(
              'commander.recovery.detail',
              'While Orca is running, save short Codex and Claude chat excerpts and Git status for local Git worktrees to Handoffs in your account.'
            )}
          </p>
        </div>
        <Switch
          id={id}
          aria-describedby={`${id}-detail`}
          disabled={!status || saving || failed}
          checked={status?.enabled ?? false}
          onCheckedChange={(value) => void update(value)}
        />
      </div>
      {failed ? (
        <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
          {t('commander.recovery.unavailable', 'Could not check the recording setting.')}
          <Button variant="ghost" size="xs" onClick={() => void update()}>
            {t('commander.memory.retry', 'Retry')}
          </Button>
        </div>
      ) : (
        status?.enabled && (
          <div role="status" className="space-y-1 text-xs text-muted-foreground">
            {status.error && (
              <p className="text-destructive">
                {t('commander.recovery.delayed', 'Handoff sync is delayed. Orca will retry.')}
              </p>
            )}
            {status.lastSyncedAt !== null ? (
              <p>
                {t('commander.recovery.synced', 'Last saved {{time}}', {
                  time: new Date(status.lastSyncedAt).toLocaleString(locale)
                })}
              </p>
            ) : (
              !status.error && (
                <p>{t('commander.recovery.waiting', 'Waiting for agent activity.')}</p>
              )
            )}
          </div>
        )
      )}
    </div>
  )
}

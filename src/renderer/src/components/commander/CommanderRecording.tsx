import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import { useSyncExternalStore } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { Switch } from '@/components/ui/switch'
import type { CommanderAccount } from '../../../../shared/commander/memory-contract'

const syncErrors = new Map<string, string>()
export function accountKey(account: CommanderAccount): string {
  return JSON.stringify([account.profileId, account.userId, account.activeOrgId ?? null])
}
export function reportCheckpointError(account: CommanderAccount, message: string): void {
  const key = accountKey(account)
  if ((syncErrors.get(key) ?? '') !== message) {
    if (message) {
      syncErrors.set(key, message)
    } else {
      syncErrors.delete(key)
    }
    window.dispatchEvent(new Event(changeEvent))
  }
}
const changeEvent = 'orca-commander-recording-changed'

export function useRecordingDevice(account: CommanderAccount | null): string | null {
  const key = account ? `commander.recording.${accountKey(account)}` : ''
  return useSyncExternalStore(subscribe, () => (key ? localStorage.getItem(key) : null))
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(changeEvent, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(changeEvent, onChange)
    window.removeEventListener('storage', onChange)
  }
}

export function CommanderRecording({ account }: { account: CommanderAccount }): React.JSX.Element {
  const device = useRecordingDevice(account)
  const t = useTranslate()
  const error = useSyncExternalStore(subscribe, () => syncErrors.get(accountKey(account)) ?? '')
  return (
    <label className="flex items-center gap-3 rounded-lg border border-border p-3">
      <span className="flex-1">
        <span className="block text-sm font-medium">
          {t('commander.recording.label', 'Record project progress from this device')}
        </span>
        <span className="text-xs text-muted-foreground">
          {t(
            'commander.recording.description',
            'Save project, agent, task and blocker summaries to your account while Orca is open.'
          )}
        </span>
        {device && error && (
          <span role="status" className="block text-xs text-destructive">
            {t('commander.recording.paused', 'Checkpoint sync will retry.')} {error}
          </span>
        )}
      </span>
      <Switch
        checked={Boolean(device)}
        onCheckedChange={(enabled) => {
          const key = `commander.recording.${accountKey(account)}`
          if (enabled) {
            const deviceKey = 'commander.recording.device'
            const value = localStorage.getItem(deviceKey) ?? createBrowserUuid()
            localStorage.setItem(deviceKey, value)
            localStorage.setItem(key, value)
          } else {
            localStorage.removeItem(key)
          }
          window.dispatchEvent(new Event(changeEvent))
        }}
      />
    </label>
  )
}

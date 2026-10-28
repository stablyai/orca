import { useId, useState } from 'react'
import type { GhAccountBinding } from '../../../../../shared/github/account-binding'
import { ghAccountBindingsEqual } from '../../../../../shared/github/account-binding'
import type { GitHubParticipant } from '../../../../../shared/github/participant-accounts'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { translate } from '@/i18n/i18n'

export function GitHubParticipantEditor({
  participant,
  participants,
  devices,
  accounts,
  saving,
  onSave,
  onCancel
}: {
  participant?: GitHubParticipant
  participants: GitHubParticipant[]
  devices: { deviceId: string; name: string }[]
  accounts: GhAccountBinding[]
  saving: boolean
  onSave: (value: Omit<GitHubParticipant, 'id'> & { id?: string }) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const nameId = useId()
  const [name, setName] = useState(participant?.name ?? '')
  const [deviceIds, setDeviceIds] = useState(participant?.deviceIds ?? [])
  const [allowedAccounts, setAllowedAccounts] = useState(participant?.allowedAccounts ?? [])
  const knownDevices = [
    ...devices,
    ...(participant?.deviceIds ?? [])
      .filter((id) => !devices.some((device) => device.deviceId === id))
      .map((deviceId) => ({ deviceId, name: deviceId }))
  ]
  const knownAccounts = [
    ...accounts,
    ...(participant?.allowedAccounts ?? []).filter(
      (account) => !accounts.some((entry) => ghAccountBindingsEqual(entry, account))
    )
  ]
  return (
    <form
      className="space-y-3 rounded-md border p-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (name.trim() && !saving) {
          void onSave({ id: participant?.id, name: name.trim(), deviceIds, allowedAccounts })
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) {
          event.stopPropagation()
          onCancel()
        }
      }}
    >
      <div className="space-y-1">
        <Label htmlFor={nameId}>
          {translate('settings.githubParticipants.memberName', 'Member name')}
        </Label>
        <Input
          id={nameId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={saving}
          required
          autoFocus
        />
      </div>
      <fieldset className="space-y-2" disabled={saving}>
        <legend className="text-xs font-semibold">
          {translate('settings.githubParticipants.devices', 'Paired devices')}
        </legend>
        {knownDevices.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'settings.githubParticipants.noDevices',
              'Pair a device with this server before assigning it to a member.'
            )}
          </p>
        ) : (
          knownDevices.map((device) => {
            const owner = participants.find(
              (entry) => entry.id !== participant?.id && entry.deviceIds.includes(device.deviceId)
            )
            return (
              <label key={device.deviceId} className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={deviceIds.includes(device.deviceId)}
                  disabled={saving || Boolean(owner)}
                  onCheckedChange={(checked) =>
                    setDeviceIds((current) =>
                      checked
                        ? [...current, device.deviceId]
                        : current.filter((id) => id !== device.deviceId)
                    )
                  }
                />
                <span>
                  {device.name}
                  {owner ? ` (${owner.name})` : ''}
                </span>
              </label>
            )
          })
        )}
      </fieldset>
      <fieldset className="space-y-2" disabled={saving}>
        <legend className="text-xs font-semibold">
          {translate('settings.githubParticipants.allowedAccounts', 'Allowed GitHub accounts')}
        </legend>
        {knownAccounts.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'settings.githubParticipants.noAccounts',
              'Sign in to GitHub CLI on this server, then refresh accounts.'
            )}
          </p>
        ) : (
          knownAccounts.map((account) => (
            <label
              key={`${account.host}/${account.user}`}
              className="flex items-center gap-2 text-xs"
            >
              <Checkbox
                checked={allowedAccounts.some((entry) => ghAccountBindingsEqual(entry, account))}
                disabled={saving}
                onCheckedChange={(checked) =>
                  setAllowedAccounts((current) =>
                    checked
                      ? [...current, account]
                      : current.filter((entry) => !ghAccountBindingsEqual(entry, account))
                  )
                }
              />
              <span>
                {account.user} @ {account.host}
              </span>
            </label>
          ))
        )}
      </fieldset>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={saving || !name.trim()}>
          {translate('settings.githubParticipants.save', 'Save member')}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={onCancel}>
          {translate('settings.githubParticipants.cancel', 'Cancel')}
        </Button>
      </div>
    </form>
  )
}

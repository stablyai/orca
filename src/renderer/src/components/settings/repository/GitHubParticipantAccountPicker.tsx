import { useId } from 'react'
import type { GhAccountBinding } from '../../../../../shared/github/account-binding'
import type { GitHubParticipantSettingsStatus } from '../../../../../shared/github/participant-accounts'
import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'
import { Label } from '../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'

const NO_SELECTION = '__no_participant_account__'

export function GitHubParticipantAccountPicker({
  status,
  saving,
  onSelect,
  onRefresh
}: {
  status: GitHubParticipantSettingsStatus
  saving: boolean
  onSelect: (account: GhAccountBinding) => void
  onRefresh: () => void
}): React.JSX.Element {
  const selectId = useId()
  return (
    <div className="space-y-2">
      {status.participantId ? (
        <>
          <p className="text-sm">
            {translate('settings.githubParticipants.signedInAs', 'Member: {{name}}', {
              name: status.participantName ?? status.participantId
            })}
          </p>
          <Label htmlFor={selectId}>
            {translate(
              'settings.githubParticipants.personalAccount',
              'Your GitHub account for this project'
            )}
          </Label>
          <Select
            value={
              status.selectedAccount
                ? JSON.stringify([status.selectedAccount.host, status.selectedAccount.user])
                : NO_SELECTION
            }
            disabled={saving || status.allowedAccounts.length === 0}
            onValueChange={(value) => {
              const account = status.allowedAccounts.find(
                (entry) => JSON.stringify([entry.host, entry.user]) === value
              )
              if (account) {
                onSelect(account)
              }
            }}
          >
            <SelectTrigger id={selectId} size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_SELECTION} disabled>
                {translate('settings.githubParticipants.chooseAccount', 'Choose an account')}
              </SelectItem>
              {status.allowedAccounts.map((account) => (
                <SelectItem
                  key={`${account.host}/${account.user}`}
                  value={JSON.stringify([account.host, account.user])}
                >
                  {account.user} @ {account.host}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!status.selectedAccount ? (
            <p className="text-xs text-muted-foreground">
              {status.allowedAccounts.length
                ? translate(
                    'settings.githubParticipants.selectionRequired',
                    'Choose an account before making GitHub issue or pull request calls.'
                  )
                : translate(
                    'settings.githubParticipants.assignmentRequired',
                    'Ask the server owner to assign a GitHub account to your member.'
                  )}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {translate(
            'settings.githubParticipants.enrollmentRequired',
            'Ask the server owner to assign this device to a member and allow a GitHub account, then refresh.'
          )}
        </p>
      )}
      <Button variant="outline" size="sm" disabled={saving} onClick={onRefresh}>
        {translate('settings.githubParticipants.refresh', 'Refresh member access')}
      </Button>
    </div>
  )
}

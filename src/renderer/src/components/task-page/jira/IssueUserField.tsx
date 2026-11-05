import { useState } from 'react'
import { JiraUserPicker } from '@/components/jira-user-picker'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-client'
import type { JiraUser } from '../../../../../shared/jira/jira-types'

export function TaskPageJiraIssueUserField({
  providerSettings,
  siteId,
  value,
  onChange,
  disabled,
  label
}: {
  providerSettings: RuntimeJiraSettings
  siteId?: string | null
  value: string
  onChange: (id: string) => void
  disabled: boolean
  label: string
}): React.JSX.Element {
  const [selectedUser, setSelectedUser] = useState<JiraUser | null>(null)
  return (
    <JiraUserPicker
      providerSettings={providerSettings}
      siteId={siteId}
      value={value}
      selectedUser={selectedUser?.accountId === value ? selectedUser : null}
      onSelect={(user) => {
        setSelectedUser(user)
        onChange(user.accountId)
      }}
      disabled={disabled}
      label={label}
      allowKnownUserId
    />
  )
}

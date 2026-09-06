import React from 'react'
import type { JiraUser } from '../../../shared/jira-types'

/** Renders the selectable user rows inside the picker popover. */
export function JiraUserOptionList({
  users,
  onSelect
}: {
  users: JiraUser[]
  onSelect: (user: JiraUser) => void
}): React.JSX.Element {
  return (
    <>
      {users.map((user) => (
        <button
          key={user.accountId}
          type="button"
          onClick={() => onSelect(user)}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
        >
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="size-5 rounded-full" />
          ) : null}
          <span className="truncate">{user.displayName}</span>
        </button>
      ))}
    </>
  )
}

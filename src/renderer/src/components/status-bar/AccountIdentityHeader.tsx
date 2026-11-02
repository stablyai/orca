import React from 'react'

export function AccountIdentityHeader({ label }: { label: string }): React.JSX.Element {
  return <div className="min-w-0 truncate text-sm font-medium">{label}</div>
}

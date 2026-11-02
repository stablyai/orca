import React from 'react'
import { DropdownMenuLabel } from '@/components/ui/dropdown-menu'

export function AccountSwitchList({
  heading,
  children
}: {
  heading: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="pb-1">
      <DropdownMenuLabel>{heading}</DropdownMenuLabel>
      <div className="max-h-[min(300px,40vh)] overflow-y-auto scrollbar-sleek">{children}</div>
    </div>
  )
}

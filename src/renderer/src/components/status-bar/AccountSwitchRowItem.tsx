import { Check } from 'lucide-react'
import React from 'react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

export function AccountSwitchRowItem({
  label,
  active,
  children,
  ...props
}: Omit<React.ComponentProps<typeof DropdownMenuItem>, 'children'> & {
  label: string
  active: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <DropdownMenuItem
      title={label}
      {...props}
      aria-current={active ? 'true' : undefined}
      data-current={active ? 'true' : undefined}
      className="min-h-7"
    >
      <span className="flex w-4 shrink-0 justify-center">
        {active ? (
          <>
            <Check className="size-3.5" />
            <span className="sr-only">
              {translate('auto.components.status.bar.StatusBar.ff0fbe9311', 'Active')}
            </span>
          </>
        ) : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {children ? <div className="w-40 shrink-0 text-xs">{children}</div> : null}
    </DropdownMenuItem>
  )
}

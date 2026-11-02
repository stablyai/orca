import { Check } from 'lucide-react'
import React from 'react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

export function AccountSwitchRowItem({
  label,
  active,
  children,
  action,
  className,
  ...props
}: Omit<React.ComponentProps<typeof DropdownMenuItem>, 'children'> & {
  label: string
  active: boolean
  children?: React.ReactNode
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center">
      <DropdownMenuItem
        title={label}
        {...props}
        aria-current={active ? 'true' : undefined}
        data-current={active ? 'true' : undefined}
        className={cn('min-h-7 min-w-0 grow basis-40', className)}
      >
        <span className="flex w-4 shrink-0 self-start justify-center">
          {active ? (
            <>
              <Check className="size-3.5" />
              <span className="sr-only">
                {translate('auto.components.status.bar.StatusBar.ff0fbe9311', 'Active')}
              </span>
            </>
          ) : null}
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <span className="min-w-0 grow basis-36 whitespace-normal break-words">{label}</span>
          {children ? <div className="min-w-0 grow basis-36 text-xs">{children}</div> : null}
        </div>
      </DropdownMenuItem>
      {action ? <div className="min-w-0 grow basis-40 px-2.5">{action}</div> : null}
    </div>
  )
}

import { Check } from 'lucide-react'
import React from 'react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'

export function AccountSwitchRowItem({
  label,
  detail,
  active,
  children,
  action,
  className,
  ...props
}: Omit<React.ComponentProps<typeof DropdownMenuItem>, 'children'> & {
  label: string
  /** Secondary line, e.g. workspace or the ID that tells same-email accounts apart. */
  detail?: string | null
  active: boolean
  /** Usage shown in the fixed-width right column so rows line up. */
  children?: React.ReactNode
  /** Rendered beside the item, not inside it, so its own menu item stays separately focusable. */
  action?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex items-center">
      <DropdownMenuItem
        title={detail ? `${label}\n${detail}` : label}
        {...props}
        aria-current={active ? 'true' : undefined}
        data-current={active ? 'true' : undefined}
        className={cn('min-h-9 min-w-0 flex-1', className)}
      >
        <span className="flex w-4 shrink-0 justify-center">
          {active ? (
            <>
              <Check className="size-3.5" />
              <span className="sr-only">
                {t('auto.components.status.bar.StatusBar.ff0fbe9311', 'Active')}
              </span>
            </>
          ) : null}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{label}</span>
          {detail ? (
            <span className="truncate text-2xs text-muted-foreground">{detail}</span>
          ) : null}
        </span>
        {children ? <div className="w-1/2 max-w-48 shrink-0 text-xs">{children}</div> : null}
      </DropdownMenuItem>
      {action ? <div className="shrink-0 pr-1.5">{action}</div> : null}
    </div>
  )
}

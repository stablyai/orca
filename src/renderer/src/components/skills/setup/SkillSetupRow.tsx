import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function SkillSetupRow({
  title,
  description,
  actions,
  error,
  children,
  className
}: {
  title: ReactNode
  description?: ReactNode
  actions: ReactNode
  error?: string | null
  children?: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div data-settings-row="" className={cn('min-w-0 py-2.5', className)}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm">{title}</p>
          {description ? (
            <p className="mt-0.5 text-settings-detail text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions}
      </div>
      {error ? <p className="mt-1 text-settings-detail text-destructive">{error}</p> : null}
      {children}
    </div>
  )
}

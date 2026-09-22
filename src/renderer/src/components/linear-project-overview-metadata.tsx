import React from 'react'

import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'

export function LinearProjectPropertyRow({
  label,
  value,
  icon
}: {
  label: string
  value: string
  icon?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-border/50 bg-muted/20 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 truncate text-sm text-foreground">{value}</div>
    </div>
  )
}

export function LinearProjectMetadataList({
  icon,
  label,
  items
}: {
  icon?: React.ReactNode
  label: string
  items: string[]
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-border/50 bg-muted/20 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
        {icon}
        {label}
      </div>
      {items.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {items.map((item) => (
            <Badge key={item} variant="outline" className="max-w-full truncate">
              {item}
            </Badge>
          ))}
        </div>
      ) : (
        <div className="mt-1 text-sm text-muted-foreground">
          {translate('auto.components.linear.project.view.surfaces.8bbecb2510', 'None')}
        </div>
      )}
    </div>
  )
}

import type { ReactNode } from 'react'
import { Label } from '../ui/label'

/** Label and short description on the left, its control on the right. */
export function SettingRow(props: {
  htmlFor: string
  label: string
  description?: string | null
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,14rem)] items-center gap-x-4">
      <div className="min-w-0">
        <Label htmlFor={props.htmlFor} className="text-sm font-medium">
          {props.label}
        </Label>
        {props.description ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{props.description}</p>
        ) : null}
      </div>
      {props.children}
    </div>
  )
}

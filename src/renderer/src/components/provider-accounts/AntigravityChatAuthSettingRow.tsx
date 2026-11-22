import type { ReactNode } from 'react'
import { Label } from '../ui/label'

/** Label on the left, its control on the right. */
export function AntigravityChatAuthSettingRow(props: {
  htmlFor: string
  label: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,14rem)] items-center gap-x-4">
      <div className="min-w-0 text-sm font-medium">
        <Label htmlFor={props.htmlFor}>{props.label}</Label>
      </div>
      {props.children}
    </div>
  )
}

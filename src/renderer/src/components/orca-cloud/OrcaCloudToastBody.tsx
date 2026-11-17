import React from 'react'
import { Button } from '@/components/ui/button'

export type OrcaCloudToastAction = {
  label: string
  onClick: () => void
  /** The toast's main action; the rest are secondary. */
  primary?: boolean
}

/** Toast description with real buttons, so a toast can offer two actions without Sonner's
 *  dismiss-only "cancel" slot standing in for one. */
export function OrcaCloudToastBody({
  text,
  actions
}: {
  text: string
  actions: readonly OrcaCloudToastAction[]
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <span>{text}</span>
      {actions.length > 0 ? (
        <div className="flex items-center gap-1.5">
          {actions.map((action) => (
            <Button
              key={action.label}
              type="button"
              size="xs"
              variant={action.primary ? 'default' : 'outline'}
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type SetupStepPreviewProps = {
  children: ReactNode
  className?: string
}

export function SetupStepPreview(props: SetupStepPreviewProps): React.JSX.Element {
  return (
    <div className={cn('relative', props.className)}>
      <div className="pointer-events-none absolute left-3 top-3 z-20 rounded-md bg-card/85 px-1.5 py-0.5 text-xs font-semibold leading-none text-muted-foreground shadow-xs backdrop-blur-sm">
        Preview
      </div>
      <div className="h-full [&>*]:h-full [&>*]:pt-8">{props.children}</div>
    </div>
  )
}

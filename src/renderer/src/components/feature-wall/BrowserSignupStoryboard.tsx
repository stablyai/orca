import type { JSX } from 'react'
import { translate } from '@/i18n/i18n'

export function BrowserSignupStoryboard(): JSX.Element {
  return (
    <div className="flex animate-[browserViewIn_360ms_cubic-bezier(.2,.8,.2,1)_both] flex-col gap-3">
      <div className="text-[15px] font-bold leading-tight">
        {translate(
          'auto.components.feature.wall.BrowserAnimatedVisual.46df009982',
          'Start your free trial'
        )}
      </div>
      <div className="h-2 w-[70%] rounded bg-foreground/10" />
      <div className="-mt-1 h-2 w-[55%] rounded bg-foreground/10" />
    </div>
  )
}

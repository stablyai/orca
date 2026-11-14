import type { JSX } from 'react'
import { CornerDownLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function FeatureWallContinueButton(props: {
  label: string
  enableKeyboardShortcut: boolean
  shortcutModifierLabel: string
  onClick: () => void
}): JSX.Element {
  return (
    <Button type="button" variant="default" className="gap-2 px-5" onClick={props.onClick}>
      {props.label}
      {props.enableKeyboardShortcut ? (
        <span className="ml-1 inline-flex items-center gap-0.5 rounded border border-primary-foreground/20 px-1.5 py-0.5 text-[10px] font-medium leading-none text-current/80">
          <span>{props.shortcutModifierLabel}</span>
          <CornerDownLeft className="size-3" />
        </span>
      ) : null}
    </Button>
  )
}

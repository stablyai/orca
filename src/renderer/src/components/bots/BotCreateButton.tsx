// New bot's primary action, drawn like Create worktree's: spinner while busy, label, ⌘↩ hint.
import React from 'react'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ButtonKeyHint } from '@/components/ui/ButtonKeyHint'
import { getScreenSubmitModifierLabel } from '@/lib/keyboard/screen-submit-shortcut'

export function BotCreateButton({
  busy,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Button>, 'size' | 'variant'> & {
  busy?: boolean
}): React.JSX.Element {
  return (
    <Button size="sm" {...props}>
      {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
      {/* Caption-sized like Create worktree's label; Button owns its own type size. */}
      <span className="text-xs">{children}</span>
      <ButtonKeyHint modifierLabel={getScreenSubmitModifierLabel()} />
    </Button>
  )
}

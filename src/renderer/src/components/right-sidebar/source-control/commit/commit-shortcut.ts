import type React from 'react'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import type { PrimaryAction } from '../../source-control-primary-action'

export function handleSourceControlCommitShortcut(
  event: React.KeyboardEvent<HTMLElement>,
  primaryAction: Pick<PrimaryAction, 'disabled' | 'kind'>,
  onCommit: () => void
): void {
  if (primaryAction.disabled || primaryAction.kind !== 'commit' || !isScreenSubmitShortcut(event)) {
    return
  }
  // Scope the shortcut to Source Control so editor/terminal/other sidebar keystrokes cannot commit.
  event.preventDefault()
  event.stopPropagation()
  onCommit()
}

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
  // Why: the handler lives on the Source Control root, so the shortcut cannot fire from the editor, terminal, or another sidebar tab.
  event.preventDefault()
  event.stopPropagation()
  onCommit()
}

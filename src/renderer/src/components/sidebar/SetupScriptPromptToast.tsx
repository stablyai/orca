import React from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

type SavedInProjectSettingsToastProps = {
  onOpenSettings: () => void
}

function SavedInProjectSettingsToast({
  onOpenSettings
}: SavedInProjectSettingsToastProps): React.JSX.Element {
  return (
    <span>
      {translate('auto.components.sidebar.SetupScriptPromptCard.a5bb8c5135', 'Saved in this')}{' '}
      <button
        type="button"
        className="rounded-sm font-medium underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={onOpenSettings}
      >
        {translate(
          'auto.components.sidebar.SetupScriptPromptCard.d9f2db2738',
          "project's settings"
        )}
      </button>
    </span>
  )
}

export function showSavedInProjectSettingsToast(input: {
  onOpenSettings: () => void
  description?: React.ReactNode
}): void {
  // Why: the save confirmation is also the fastest path back to the exact
  // local setup editor the user just changed.
  toast.success(<SavedInProjectSettingsToast onOpenSettings={input.onOpenSettings} />, {
    description: input.description
  })
}

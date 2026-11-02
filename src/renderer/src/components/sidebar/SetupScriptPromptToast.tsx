import React from 'react'
import { toast } from 'sonner'
import { Trans } from 'react-i18next'
import { i18n, translate } from '@/i18n/i18n'

type SavedInProjectSettingsToastProps = {
  onOpenSettings: () => void
}

function SavedInProjectSettingsToast({
  onOpenSettings
}: SavedInProjectSettingsToastProps): React.JSX.Element {
  return (
    <span>
      <Trans
        i18n={i18n}
        defaults={translate(
          'auto.components.sidebar.SetupScriptPromptCard.savedInProjectSettings',
          "Saved in this <settings>project's settings</settings>"
        )}
        components={{
          settings: (
            <button
              type="button"
              className="rounded-sm font-medium underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={onOpenSettings}
            />
          )
        }}
      />
    </span>
  )
}

export function showSavedInProjectSettingsToast(input: {
  onOpenSettings: () => void
  description?: React.ReactNode
}): void {
  // Save confirmation links back to the exact local setup editor just changed.
  toast.success(<SavedInProjectSettingsToast onOpenSettings={input.onOpenSettings} />, {
    description: input.description
  })
}

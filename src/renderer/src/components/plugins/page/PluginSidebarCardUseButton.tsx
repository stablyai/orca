import React from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

/** Draws workspaces with this plugin card, or goes back to Orca's card when it is in use. */
export function PluginSidebarCardUseButton({ cardId }: { cardId: string }): React.JSX.Element {
  const inUse = useAppStore((state) => state.settings?.workspaceCardId === cardId)
  const updateSettings = useAppStore((state) => state.updateSettings)
  return (
    <Button
      variant="outline"
      size="xs"
      onClick={() => void updateSettings({ workspaceCardId: inUse ? undefined : cardId })}
    >
      {inUse
        ? translate('auto.components.plugins.sidebarCard.useOrcaCard', "Use Orca's card")
        : translate('auto.components.plugins.sidebarCard.useCard', 'Use for workspaces')}
    </Button>
  )
}

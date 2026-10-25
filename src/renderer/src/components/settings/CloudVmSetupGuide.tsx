import type React from 'react'
import { ArrowUpRight, Cloud } from 'lucide-react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'

/** Header of the Cloud VMs card: what they are and where their recipes are set up. */
export function CloudVmSetupGuide({
  refreshAction
}: {
  refreshAction?: React.ReactNode
}): React.JSX.Element {
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)

  return (
    <div className="flex items-center gap-3 px-4 py-3" data-settings-section="cloud-vm-setup">
      <Cloud className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">
          {translate('auto.components.settings.CloudVmSetupGuide.cardTitle', 'Cloud VMs')}
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.CloudVmSetupGuide.cardDescription',
            'Created per workspace from an environment recipe.'
          )}
        </p>
      </div>
      {refreshAction}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() =>
          openSettingsTarget({
            pane: 'experimental',
            repoId: null,
            sectionId: 'ephemeral-vms'
          })
        }
      >
        {translate('auto.components.settings.CloudVmSetupGuide.setUpRecipes', 'Set up recipes')}
        <ArrowUpRight />
      </Button>
    </div>
  )
}

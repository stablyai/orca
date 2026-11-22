import type React from 'react'
import { ArrowUpRight, Cloud } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../../ui/button'

export function CloudVmSetupGuide({
  refreshAction
}: {
  refreshAction?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)

  return (
    <div className="flex items-center gap-3 px-4 py-3" data-settings-section="cloud-vm-setup">
      <Cloud className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">
          {t('auto.components.settings.CloudVmSetupGuide.cardTitle', 'Cloud VMs')}
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
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
        {t('auto.components.settings.CloudVmSetupGuide.setUpRecipes', 'Set up recipes')}
        <ArrowUpRight />
      </Button>
    </div>
  )
}

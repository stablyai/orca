import type React from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'

export function CloudVmSetupGuide(): React.JSX.Element {
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)

  return (
    <section className="space-y-3" data-settings-section="cloud-vm-setup">
      <div className="space-y-1">
        <div className="text-sm font-medium">
          {translate('auto.components.settings.CloudVmSetupGuide.title', 'Create a Cloud VM')}
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.CloudVmSetupGuide.description',
            'Cloud VMs are created from environment recipes when you create a workspace.'
          )}
        </p>
      </div>
      <ol className="ml-4 list-decimal space-y-1 text-xs text-muted-foreground">
        <li>
          {translate(
            'auto.components.settings.CloudVmSetupGuide.setupRecipe',
            'Set up an environment recipe for your cloud provider.'
          )}
        </li>
        <li>
          {translate(
            'auto.components.settings.CloudVmSetupGuide.createWorkspace',
            'Create a workspace and select that recipe under Run on.'
          )}
        </li>
      </ol>
      <Button
        type="button"
        size="sm"
        onClick={() =>
          openSettingsTarget({
            pane: 'experimental',
            repoId: null,
            sectionId: 'ephemeral-vms'
          })
        }
      >
        {translate(
          'auto.components.settings.CloudVmSetupGuide.openSetup',
          'Set up environment recipes'
        )}
      </Button>
    </section>
  )
}

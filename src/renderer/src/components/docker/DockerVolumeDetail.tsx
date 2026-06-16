import React, { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { DockerVolumeSummary } from '../../../../shared/docker-types'
import { DockerConfirmDialog } from './DockerConfirmDialog'

export function DockerVolumeDetail({ volume }: { volume: DockerVolumeSummary }): React.JSX.Element {
  const removeDockerResource = useAppStore((s) => s.removeDockerResource)
  const [removeOpen, setRemoveOpen] = useState(false)

  const handleRemove = async (): Promise<void> => {
    try {
      await removeDockerResource('volume', volume.name)
    } catch (error) {
      toast.error(
        translate('auto.components.docker.DockerVolumeDetail.4f695bd438', 'Remove volume failed'),
        { description: String(error) }
      )
    }
  }

  return (
    <div className="p-4 flex flex-col gap-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">
          {translate('auto.components.docker.DockerVolumeDetail.98fb57bff4', 'Name')}
        </dt>
        <dd>{volume.name}</dd>
        <dt className="text-muted-foreground">
          {translate('auto.components.docker.DockerVolumeDetail.33ffc167f8', 'Driver')}
        </dt>
        <dd>{volume.driver}</dd>
        <dt className="text-muted-foreground">
          {translate('auto.components.docker.DockerVolumeDetail.fc5e2a0073', 'Scope')}
        </dt>
        <dd>{volume.scope}</dd>
        <dt className="text-muted-foreground">
          {translate('auto.components.docker.DockerVolumeDetail.967e44535f', 'Mountpoint')}
        </dt>
        <dd className="font-mono">{volume.mountpoint}</dd>
      </dl>

      <Button variant="destructive" size="xs" onClick={() => setRemoveOpen(true)}>
        {translate('auto.components.docker.DockerVolumeDetail.1637268c8c', 'Remove')}
      </Button>

      <DockerConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={translate('auto.components.docker.DockerVolumeDetail.4928a5801c', 'Remove volume')}
        description={translate(
          'auto.components.docker.DockerVolumeDetail.4847a3b597',
          'Remove {{value0}}? This cannot be undone.',
          { value0: volume.name }
        )}
        confirmLabel={translate('auto.components.docker.DockerVolumeDetail.1637268c8c', 'Remove')}
        onConfirm={handleRemove}
      />
    </div>
  )
}

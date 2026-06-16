import React, { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { DockerNetworkSummary } from '../../../../shared/docker-types'
import { DockerConfirmDialog } from './DockerConfirmDialog'

export function DockerNetworkDetail({
  network
}: {
  network: DockerNetworkSummary
}): React.JSX.Element {
  const removeDockerResource = useAppStore((s) => s.removeDockerResource)
  const [removeOpen, setRemoveOpen] = useState(false)

  const handleRemove = async (): Promise<void> => {
    try {
      await removeDockerResource('network', network.id)
    } catch (error) {
      toast.error(
        translate('auto.components.docker.DockerNetworkDetail.ec90189068', 'Remove network failed'),
        { description: String(error) }
      )
      throw error // keep the confirm dialog open on failure
    }
  }

  return (
    <div className="p-4 flex flex-col gap-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">
          {translate('auto.components.docker.DockerNetworkDetail.81e34d5dc0', 'Name')}
        </dt>
        <dd>{network.name}</dd>
        <dt className="text-muted-foreground">
          {translate('auto.components.docker.DockerNetworkDetail.6832680cb6', 'ID')}
        </dt>
        <dd className="font-mono">{network.id.slice(0, 12)}</dd>
        <dt className="text-muted-foreground">
          {translate('auto.components.docker.DockerNetworkDetail.d22b44e993', 'Driver')}
        </dt>
        <dd>{network.driver}</dd>
        <dt className="text-muted-foreground">
          {translate('auto.components.docker.DockerNetworkDetail.9bdc0f1920', 'Scope')}
        </dt>
        <dd>{network.scope}</dd>
      </dl>

      <Button variant="destructive" size="xs" onClick={() => setRemoveOpen(true)}>
        {translate('auto.components.docker.DockerNetworkDetail.84c366377a', 'Remove')}
      </Button>

      <DockerConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={translate(
          'auto.components.docker.DockerNetworkDetail.1c4c7c8eaa',
          'Remove network'
        )}
        description={translate(
          'auto.components.docker.DockerNetworkDetail.fcc0b34426',
          'Remove {{value0}}? This cannot be undone.',
          { value0: network.name }
        )}
        confirmLabel={translate('auto.components.docker.DockerNetworkDetail.84c366377a', 'Remove')}
        onConfirm={handleRemove}
      />
    </div>
  )
}

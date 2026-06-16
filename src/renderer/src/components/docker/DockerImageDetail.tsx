import React, { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { DockerImageSummary } from '../../../../shared/docker-types'
import { DockerConfirmDialog } from './DockerConfirmDialog'

function formatBytes(sizeStr: string): string {
  const bytes = Number(sizeStr)
  if (Number.isNaN(bytes)) return sizeStr
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function DockerImageDetail({ image }: { image: DockerImageSummary }): React.JSX.Element {
  const removeDockerResource = useAppStore((s) => s.removeDockerResource)
  const [removeOpen, setRemoveOpen] = useState(false)

  const handleRemove = async (): Promise<void> => {
    try {
      await removeDockerResource('image', image.id)
    } catch (error) {
      toast.error(
        translate('auto.components.docker.DockerImageDetail.07b83a4ee4', 'Remove image failed'),
        { description: String(error) }
      )
    }
  }

  const imageLabel = image.repository !== '<none>' ? `${image.repository}:${image.tag}` : image.id.slice(0, 12)

  return (
    <div className="p-4 flex flex-col gap-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">
          {translate('auto.components.docker.DockerImageDetail.59bb4e75a1', 'Repository')}
        </dt>
        <dd>{image.repository}</dd>
        <dt className="text-muted-foreground">
          {translate('auto.components.docker.DockerImageDetail.f149921de1', 'Tag')}
        </dt>
        <dd>{image.tag}</dd>
        <dt className="text-muted-foreground">
          {translate('auto.components.docker.DockerImageDetail.1cc6d277be', 'ID')}
        </dt>
        <dd className="font-mono">{image.id.slice(0, 12)}</dd>
        <dt className="text-muted-foreground">
          {translate('auto.components.docker.DockerImageDetail.18cd49f788', 'Size')}
        </dt>
        <dd>{formatBytes(image.size)}</dd>
        <dt className="text-muted-foreground">
          {translate('auto.components.docker.DockerImageDetail.656e03218c', 'Created')}
        </dt>
        <dd>{image.createdSince}</dd>
      </dl>

      <Button variant="destructive" size="xs" onClick={() => setRemoveOpen(true)}>
        {translate('auto.components.docker.DockerImageDetail.4471eb1783', 'Remove')}
      </Button>

      <DockerConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={translate('auto.components.docker.DockerImageDetail.adb63093a6', 'Remove image')}
        description={translate(
          'auto.components.docker.DockerImageDetail.698395402c',
          'Remove {{value0}}? This cannot be undone.',
          { value0: imageLabel }
        )}
        confirmLabel={translate('auto.components.docker.DockerImageDetail.4471eb1783', 'Remove')}
        onConfirm={handleRemove}
      />
    </div>
  )
}

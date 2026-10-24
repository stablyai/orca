import type { JSX } from 'react'
import { translate } from '@/i18n/i18n'
import GlbViewer from './GlbViewer'
import { useGltfResourceReader } from './use-gltf-resource-reader'

export default function GltfFileViewer({
  content,
  filePath,
  relativePath,
  worktreeId,
  runtimeEnvironmentId,
  externalSshTargetId
}: {
  content: string
  filePath: string
  relativePath: string | null | undefined
  worktreeId: string | null | undefined
  runtimeEnvironmentId: string | null | undefined
  externalSshTargetId: string | undefined
}): JSX.Element {
  const readResource = useGltfResourceReader({
    filePath,
    relativePath,
    worktreeId,
    runtimeEnvironmentId,
    externalSshTargetId
  })
  if (!readResource) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {translate('glbPreview.loading', 'Loading 3D model…')}
      </div>
    )
  }
  return (
    <GlbViewer content={content} format="gltf" filePath={filePath} readResource={readResource} />
  )
}

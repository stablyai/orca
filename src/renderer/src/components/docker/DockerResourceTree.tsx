import React from 'react'
import { Circle, Eraser } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type {
  DockerContainerSummary,
  DockerImageSummary,
  DockerNetworkSummary,
  DockerResourceKind,
  DockerResourceSelection,
  DockerVolumeSummary
} from '../../../../shared/docker-types'

export function DockerResourceTree({
  containers,
  images,
  volumes,
  networks,
  selected,
  onSelect,
  onPrune
}: {
  containers: DockerContainerSummary[]
  images: DockerImageSummary[]
  volumes: DockerVolumeSummary[]
  networks: DockerNetworkSummary[]
  selected: DockerResourceSelection | null
  onSelect: (selection: DockerResourceSelection) => void
  onPrune: (kind: DockerResourceKind) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5 p-2">
      {/* Containers section */}
      <SectionHeader
        label={translate('auto.components.docker.DockerResourceTree.467cfca8f2', 'Containers')}
        kind="container"
        onPrune={onPrune}
      />
      {containers.length === 0 ? (
        <EmptyState
          message={translate('auto.components.docker.DockerResourceTree.7964843ebd', 'No containers.')}
        />
      ) : (
        containers.map((c) => {
          const isSelected = selected?.kind === 'container' && selected?.id === c.id
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelect({ kind: 'container', id: c.id })}
              data-current={isSelected ? 'true' : undefined}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent',
                isSelected && 'bg-accent'
              )}
            >
              <Circle
                className={cn(
                  'size-2 shrink-0',
                  // Why: use semantic design tokens (text-primary / text-muted-foreground)
                  // not git-decoration-* colors — those are reserved for git status indicators.
                  c.state === 'running'
                    ? 'fill-primary text-primary'
                    : 'fill-muted-foreground text-muted-foreground'
                )}
              />
              <span className="flex-1 truncate">{c.names[0] ?? c.id.slice(0, 12)}</span>
              <span className="truncate text-xs text-muted-foreground">{c.image}</span>
            </button>
          )
        })
      )}

      {/* Images section */}
      <SectionHeader
        label={translate('auto.components.docker.DockerResourceTree.b9b10ffd73', 'Images')}
        kind="image"
        onPrune={onPrune}
      />
      {images.length === 0 ? (
        <EmptyState
          message={translate('auto.components.docker.DockerResourceTree.ef8715fa3c', 'No images.')}
        />
      ) : (
        images.map((img) => {
          const isSelected = selected?.kind === 'image' && selected?.id === img.id
          const label =
            img.repository === '<none>'
              ? img.id.slice(0, 12)
              : `${img.repository}:${img.tag}`
          return (
            <button
              key={img.id}
              type="button"
              onClick={() => onSelect({ kind: 'image', id: img.id })}
              data-current={isSelected ? 'true' : undefined}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent',
                isSelected && 'bg-accent'
              )}
            >
              <span className="flex-1 truncate">{label}</span>
              <span className="truncate text-xs text-muted-foreground">{img.size}</span>
            </button>
          )
        })
      )}

      {/* Volumes section */}
      <SectionHeader
        label={translate('auto.components.docker.DockerResourceTree.12b0eb1a8a', 'Volumes')}
        kind="volume"
        onPrune={onPrune}
      />
      {volumes.length === 0 ? (
        <EmptyState
          message={translate('auto.components.docker.DockerResourceTree.fb6116f299', 'No volumes.')}
        />
      ) : (
        volumes.map((vol) => {
          const isSelected = selected?.kind === 'volume' && selected?.id === vol.name
          return (
            <button
              key={vol.name}
              type="button"
              onClick={() => onSelect({ kind: 'volume', id: vol.name })}
              data-current={isSelected ? 'true' : undefined}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent',
                isSelected && 'bg-accent'
              )}
            >
              <span className="flex-1 truncate">{vol.name}</span>
              <span className="truncate text-xs text-muted-foreground">{vol.driver}</span>
            </button>
          )
        })
      )}

      {/* Networks section */}
      <SectionHeader
        label={translate('auto.components.docker.DockerResourceTree.340bf27dfd', 'Networks')}
        kind="network"
        onPrune={onPrune}
      />
      {networks.length === 0 ? (
        <EmptyState
          message={translate('auto.components.docker.DockerResourceTree.2fe5d96a6c', 'No networks.')}
        />
      ) : (
        networks.map((net) => {
          const isSelected = selected?.kind === 'network' && selected?.id === net.id
          return (
            <button
              key={net.id}
              type="button"
              onClick={() => onSelect({ kind: 'network', id: net.id })}
              data-current={isSelected ? 'true' : undefined}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent',
                isSelected && 'bg-accent'
              )}
            >
              <span className="flex-1 truncate">{net.name}</span>
              <span className="truncate text-xs text-muted-foreground">{net.driver}</span>
            </button>
          )
        })
      )}
    </div>
  )
}

function SectionHeader({
  label,
  kind,
  onPrune
}: {
  label: string
  kind: DockerResourceKind
  onPrune: (kind: DockerResourceKind) => void
}): React.JSX.Element {
  return (
    <div className="mt-1 flex items-center justify-between px-2 pb-1">
      <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {label}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        title={translate('auto.components.docker.DockerResourceTree.03f84060b4', 'Prune')}
        aria-label={translate('auto.components.docker.DockerResourceTree.03f84060b4', 'Prune')}
        onClick={() => onPrune(kind)}
      >
        <Eraser />
      </Button>
    </div>
  )
}

function EmptyState({ message }: { message: string }): React.JSX.Element {
  return <div className="px-2 py-1 text-xs text-muted-foreground">{message}</div>
}

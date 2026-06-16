import React, { useState } from 'react'
import { ChevronDown, ChevronRight, Circle, Eraser } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { buildDockerContainerGroups } from './docker-container-groups'
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
  // Default empty set = all nodes collapsed; only keys in `expanded` are open
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  function toggle(key: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const groups = buildDockerContainerGroups(containers)

  return (
    <div className="flex flex-col gap-0.5 p-2">
      {/* Compose project nodes */}
      {groups.composeProjects.map(({ project, services }) => {
        const projectKey = `project:${project}`
        const projectCollapsed = !expanded.has(projectKey)
        return (
          <div key={project}>
            <TreeNodeHeader
              label={translate(
                'auto.components.docker.DockerResourceTree.71037a0124',
                'Docker-compose: {{value0}}',
                { value0: project }
              )}
              collapsed={projectCollapsed}
              onToggle={() => toggle(projectKey)}
              depth={0}
            />
            {!projectCollapsed &&
              services.map(({ service, containers: serviceContainers }) => {
                // A service group with an empty name renders containers directly under the project node
                if (service === '') {
                  return (
                    <React.Fragment key={`service:${project}/`}>
                      {serviceContainers.map((c) => (
                        <ContainerRow
                          key={c.id}
                          container={c}
                          selected={selected}
                          onSelect={onSelect}
                          depth={1}
                        />
                      ))}
                    </React.Fragment>
                  )
                }

                const serviceKey = `service:${project}/${service}`
                const serviceCollapsed = !expanded.has(serviceKey)
                return (
                  <div key={serviceKey}>
                    <TreeNodeHeader
                      label={service}
                      collapsed={serviceCollapsed}
                      onToggle={() => toggle(serviceKey)}
                      depth={1}
                    />
                    {!serviceCollapsed &&
                      serviceContainers.map((c) => (
                        <ContainerRow
                          key={c.id}
                          container={c}
                          selected={selected}
                          onSelect={onSelect}
                          depth={2}
                        />
                      ))}
                  </div>
                )
              })}
          </div>
        )
      })}

      {/* Standalone Containers node */}
      {(() => {
        const key = 'section:containers'
        const isCollapsed = !expanded.has(key)
        return (
          <div>
            <TreeNodeHeader
              label={translate(
                'auto.components.docker.DockerResourceTree.467cfca8f2',
                'Containers'
              )}
              collapsed={isCollapsed}
              onToggle={() => toggle(key)}
              depth={0}
            />
            {!isCollapsed &&
              (groups.standalone.length === 0 ? (
                <EmptyState
                  message={translate(
                    'auto.components.docker.DockerResourceTree.7964843ebd',
                    'No containers.'
                  )}
                  depth={1}
                />
              ) : (
                groups.standalone.map((c) => (
                  <ContainerRow
                    key={c.id}
                    container={c}
                    selected={selected}
                    onSelect={onSelect}
                    depth={1}
                  />
                ))
              ))}
          </div>
        )
      })()}

      {/* Images node */}
      {(() => {
        const key = 'section:images'
        const isCollapsed = !expanded.has(key)
        return (
          <div>
            <TreeNodeHeader
              label={translate('auto.components.docker.DockerResourceTree.b9b10ffd73', 'Images')}
              collapsed={isCollapsed}
              onToggle={() => toggle(key)}
              depth={0}
              pruneKind="image"
              onPrune={onPrune}
            />
            {!isCollapsed &&
              (images.length === 0 ? (
                <EmptyState
                  message={translate(
                    'auto.components.docker.DockerResourceTree.ef8715fa3c',
                    'No images.'
                  )}
                  depth={1}
                />
              ) : (
                images.map((img) => {
                  const isSelected = selected?.kind === 'image' && selected?.id === img.id
                  const label =
                    img.repository === '<none>' ? img.id.slice(0, 12) : `${img.repository}:${img.tag}`
                  return (
                    <button
                      key={img.id}
                      type="button"
                      onClick={() => onSelect({ kind: 'image', id: img.id })}
                      data-current={isSelected ? 'true' : undefined}
                      style={{ paddingLeft: `${1 * 16}px` }}
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
              ))}
          </div>
        )
      })()}

      {/* Networks node */}
      {(() => {
        const key = 'section:networks'
        const isCollapsed = !expanded.has(key)
        return (
          <div>
            <TreeNodeHeader
              label={translate('auto.components.docker.DockerResourceTree.340bf27dfd', 'Networks')}
              collapsed={isCollapsed}
              onToggle={() => toggle(key)}
              depth={0}
              pruneKind="network"
              onPrune={onPrune}
            />
            {!isCollapsed &&
              (networks.length === 0 ? (
                <EmptyState
                  message={translate(
                    'auto.components.docker.DockerResourceTree.2fe5d96a6c',
                    'No networks.'
                  )}
                  depth={1}
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
                      style={{ paddingLeft: `${1 * 16}px` }}
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
              ))}
          </div>
        )
      })()}

      {/* Volumes node */}
      {(() => {
        const key = 'section:volumes'
        const isCollapsed = !expanded.has(key)
        return (
          <div>
            <TreeNodeHeader
              label={translate('auto.components.docker.DockerResourceTree.12b0eb1a8a', 'Volumes')}
              collapsed={isCollapsed}
              onToggle={() => toggle(key)}
              depth={0}
              pruneKind="volume"
              onPrune={onPrune}
            />
            {!isCollapsed &&
              (volumes.length === 0 ? (
                <EmptyState
                  message={translate(
                    'auto.components.docker.DockerResourceTree.fb6116f299',
                    'No volumes.'
                  )}
                  depth={1}
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
                      style={{ paddingLeft: `${1 * 16}px` }}
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
              ))}
          </div>
        )
      })()}
    </div>
  )
}

function TreeNodeHeader({
  label,
  collapsed,
  onToggle,
  depth,
  pruneKind,
  onPrune
}: {
  label: string
  collapsed: boolean
  onToggle: () => void
  depth: number
  pruneKind?: DockerResourceKind
  onPrune?: (kind: DockerResourceKind) => void
}): React.JSX.Element {
  const Chevron = collapsed ? ChevronRight : ChevronDown
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
      className="mt-1 flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left transition-colors hover:bg-accent"
    >
      <Chevron className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="flex-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {label}
      </span>
      {pruneKind !== undefined && onPrune !== undefined && (
        <Button
          variant="ghost"
          size="icon-xs"
          title={translate('auto.components.docker.DockerResourceTree.03f84060b4', 'Prune')}
          aria-label={translate('auto.components.docker.DockerResourceTree.03f84060b4', 'Prune')}
          onClick={(e) => {
            // Stop propagation so the prune click doesn't also collapse/expand the node
            e.stopPropagation()
            onPrune(pruneKind)
          }}
        >
          <Eraser />
        </Button>
      )}
    </button>
  )
}

function ContainerRow({
  container: c,
  selected,
  onSelect,
  depth
}: {
  container: DockerContainerSummary
  selected: DockerResourceSelection | null
  onSelect: (sel: DockerResourceSelection) => void
  depth: number
}): React.JSX.Element {
  const isSelected = selected?.kind === 'container' && selected?.id === c.id
  return (
    <button
      type="button"
      onClick={() => onSelect({ kind: 'container', id: c.id })}
      data-current={isSelected ? 'true' : undefined}
      style={{ paddingLeft: `${depth * 16}px` }}
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
    </button>
  )
}

function EmptyState({ message, depth }: { message: string; depth: number }): React.JSX.Element {
  return (
    <div style={{ paddingLeft: `${depth * 16 + 8}px` }} className="py-1 text-xs text-muted-foreground">
      {message}
    </div>
  )
}

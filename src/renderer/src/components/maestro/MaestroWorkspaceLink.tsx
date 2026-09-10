import { Trash2 } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { translate } from '@/i18n/i18n'
import type {
  MaestroWorkspaceLinkGeometry,
  MaestroWorkspaceLinkKind,
  MaestroWorkspaceLinkLine,
  MaestroWorkspaceLinkPresentation
} from './MaestroWorkspaceLinks'

export function MaestroWorkspaceLinkArtwork({
  kind,
  geometry,
  presentation,
  incident,
  selected,
  dimmed
}: {
  kind: MaestroWorkspaceLinkKind
  geometry: MaestroWorkspaceLinkGeometry
  presentation: MaestroWorkspaceLinkPresentation
  incident: boolean
  selected: boolean
  dimmed: boolean
}): React.JSX.Element {
  const labelWidth = presentation.label ? presentation.label.length * 6.5 + 16 : 0
  const opacity = selected
    ? 1
    : dimmed
      ? presentation.opacity * 0.3
      : incident
        ? Math.min(1, presentation.opacity + 0.2)
        : presentation.opacity
  const stroke =
    selected || incident
      ? 'var(--ring)'
      : kind === 'delegates'
        ? 'color-mix(in srgb, var(--ring) 48%, var(--muted-foreground))'
        : 'var(--muted-foreground)'

  return (
    <>
      {selected ? (
        <path
          d={geometry.path}
          fill="none"
          stroke="var(--ring)"
          strokeWidth={8}
          opacity={0.18}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      <path
        d={geometry.path}
        fill="none"
        stroke={stroke}
        strokeWidth={selected ? Math.max(2.75, presentation.width + 1) : presentation.width}
        strokeDasharray={presentation.dash}
        opacity={opacity}
        vectorEffect="non-scaling-stroke"
      />
      {presentation.label ? (
        <>
          <rect
            x={geometry.label.x - labelWidth / 2}
            y={geometry.label.y - 9}
            width={labelWidth}
            height={18}
            rx={6}
            fill="var(--card)"
            stroke={selected ? 'var(--ring)' : 'var(--border)'}
            strokeWidth={selected ? 1.5 : 1}
            opacity={dimmed && !selected ? 0.38 : 0.96}
            vectorEffect="non-scaling-stroke"
          />
          <text
            x={geometry.label.x}
            y={geometry.label.y + 3.5}
            textAnchor="middle"
            fontSize={10}
            fontWeight={600}
            fill="var(--foreground)"
            opacity={dimmed && !selected ? 0.42 : 0.92}
          >
            {presentation.label}
          </text>
        </>
      ) : null}
    </>
  )
}

export function MaestroWorkspaceManualLink({
  link,
  geometry,
  presentation,
  selected,
  dimmed,
  accessibleLabel,
  onSelect,
  onDelete
}: {
  link: MaestroWorkspaceLinkLine
  geometry: MaestroWorkspaceLinkGeometry
  presentation: MaestroWorkspaceLinkPresentation
  selected: boolean
  dimmed: boolean
  accessibleLabel: string
  onSelect: () => void
  onDelete: () => void
}): React.JSX.Element {
  return (
    <ContextMenu onOpenChange={(open) => open && onSelect()}>
      <ContextMenuTrigger asChild>
        <g
          className="pointer-events-auto cursor-pointer outline-none"
          data-link-provenance={link.provenance}
          data-link-kind={link.kind}
          data-link-source={link.source}
          data-link-target={link.target}
          data-link-selected={selected ? 'true' : undefined}
          data-maestro-manual-link={link.id}
          role="button"
          aria-label={accessibleLabel}
          aria-pressed={selected}
          tabIndex={0}
          onFocus={onSelect}
          onPointerDown={(event) => {
            event.stopPropagation()
            event.currentTarget.focus()
          }}
          onClick={(event) => {
            event.stopPropagation()
            onSelect()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onSelect()
              return
            }
            if (event.key === 'Delete' || event.key === 'Backspace') {
              event.preventDefault()
              event.stopPropagation()
              onDelete()
            }
          }}
        >
          <title>{accessibleLabel}</title>
          <path
            d={geometry.path}
            fill="none"
            stroke="transparent"
            strokeWidth={28}
            strokeLinecap="round"
            strokeLinejoin="round"
            pointerEvents="stroke"
            vectorEffect="non-scaling-stroke"
          />
          <MaestroWorkspaceLinkArtwork
            kind={link.kind}
            geometry={geometry}
            presentation={presentation}
            incident={false}
            selected={selected}
            dimmed={dimmed}
          />
        </g>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 />
          {translate('auto.components.maestro.links.remove', 'Remove link')}
          <ContextMenuShortcut>
            {translate('auto.components.maestro.links.deleteShortcut', 'Delete')}
          </ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

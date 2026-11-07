import React, { useCallback } from 'react'
import { Smartphone } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { BrowserFavicon } from '@/components/browser-favicon'
import { FileTypeIcon, FolderIcon } from '@/components/FileTypeIcon'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { ShellIcon, shellIconKind } from '../tab-bar/shell-icons'
import {
  decodeLeadingTabIcon,
  selectWorktreeLeadingTabs,
  type LeadingTabIcon
} from './worktree-card-leading-tabs'
import type { SlotException } from './worktree-card-slot-signal'
import type { SlotTarget } from './worktree-card-slot-targets'
import { SlotJumpTrigger, SlotKindGlyph } from './worktree-card-slot-jump'
import { slotLabel } from './WorktreeCardSlot'

const LAYERS = ['front', 'l1', 'l2', 'l3'] as const

/** Generic shells get a tile-sized terminal face; the 24px tab-strip glyph turns blocky at 15px. */
function TerminalTileFace(): React.JSX.Element {
  return (
    <span className="worktree-card-leading-terminal" aria-hidden>
      <svg width="18" height="15" viewBox="0 0 18 15">
        <path
          d="M4.25 4.5 7 7.25 4.25 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M8.5 10h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </span>
  )
}

function TabGlyph({ icon }: { icon: LeadingTabIcon }): React.JSX.Element {
  switch (icon.kind) {
    case 'agent':
      return <AgentIcon agent={icon.agent} size={11} />
    case 'shell':
      return <ShellIcon shell={icon.shell} size={11} />
    case 'browser':
      return <BrowserFavicon faviconUrl={icon.faviconUrl} className="size-[11px]" />
    case 'file':
      return <FileTypeIcon filePath={icon.filePath} className="size-[11px]" />
    case 'simulator':
      return <Smartphone className="size-[11px]" aria-hidden />
  }
}

/** Badge kinds the icon carries; needs/failed get the louder label pill on the right instead. */
export type LeadingIconBadge = Extract<SlotException, { kind: 'unread' } | { kind: 'working' }>

/**
 * The card's leading icon: the most recently focused tab in front, up to three more layered
 * behind it, and the quiet statuses (unread, working) as a corner badge.
 */
export function WorktreeCardLeadingIcon({
  worktreeId,
  badge,
  offline,
  resolveTargets
}: {
  worktreeId: string
  badge: LeadingIconBadge | null
  offline: boolean
  resolveTargets: (kind: SlotException['kind']) => SlotTarget[]
}): React.JSX.Element {
  const encoded = useAppStore(
    useShallow(
      useCallback((state: AppState) => selectWorktreeLeadingTabs(state, worktreeId), [worktreeId])
    )
  )
  const icons = encoded.map(decodeLeadingTabIcon)
  return (
    <span
      className={cn('worktree-card-leading-icon', offline && 'worktree-card-leading-icon-offline')}
      data-layers={icons.length}
      aria-hidden={badge === null}
    >
      {icons.length === 0 ? (
        <span className="worktree-card-leading-tile" data-layer="front">
          <FolderIcon open={false} className="size-[11px] text-muted-foreground" />
        </span>
      ) : (
        // Back to front so later layers paint over earlier ones without z-index fights.
        icons
          .map((icon, index) => (
            <span
              key={index}
              className="worktree-card-leading-tile"
              data-layer={LAYERS[index]}
              data-kind={icon.kind}
            >
              {icon.kind === 'shell' && shellIconKind(icon.shell) === 'generic' ? (
                <TerminalTileFace />
              ) : icon.kind === 'shell' ? (
                // Shell icons are already landscape tiles (21x18 of 24); at 21px they fill this one.
                <span className="worktree-card-leading-fill" aria-hidden>
                  <ShellIcon shell={icon.shell} size={21} />
                </span>
              ) : (
                <>
                  {/* The glyph, blurred and enlarged, tints its own tile: Claude reads orange. */}
                  <span className="worktree-card-leading-tint" aria-hidden>
                    <TabGlyph icon={icon} />
                  </span>
                  {index === 0 ? (
                    <span className="worktree-card-leading-glyph">
                      <TabGlyph icon={icon} />
                    </span>
                  ) : null}
                </>
              )}
            </span>
          ))
          .toReversed()
      )}
      {badge ? (
        <SlotJumpTrigger
          label={slotLabel(badge) ?? ''}
          resolveTargets={() => resolveTargets(badge.kind)}
          className="worktree-card-leading-badge"
        >
          <span data-worktree-card-slot={badge.kind} className="inline-flex">
            <SlotKindGlyph
              kind={badge.kind}
              monitoring={badge.kind === 'working' && badge.monitoring === true}
              spinnerClassName="size-2"
            />
          </span>
        </SlotJumpTrigger>
      ) : null}
    </span>
  )
}

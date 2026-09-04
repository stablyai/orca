import React from 'react'
import { ChevronDown, LayoutGrid, Minus, Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { cn } from '@/lib/utils'
import { FilterOptionCount } from '../dashboard-popout/FilterOptionCount'
import type {
  SessionGridLayoutPreset,
  SessionGridScrollMode,
  SessionGridWheelTarget
} from '../../../../shared/session-grid-types'
import {
  SESSION_GRID_PRESETS,
  SESSION_GRID_SCROLL_MODES,
  SESSION_GRID_WHEEL_TARGETS
} from '../../../../shared/session-grid-types'
import {
  SESSION_GRID_ZOOM_DEFAULT,
  SESSION_GRID_ZOOM_MAX,
  SESSION_GRID_ZOOM_MIN
} from '@/store/slices/session-grid-zoom'
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

const getPresetLabels = createLocalizedCatalog<Record<SessionGridLayoutPreset, string>>(() => ({
  auto: translate('auto.components.session.grid.SessionGridToolbar.8909cc10c3', 'Auto'),
  '1x2': '1×2',
  '2x1': '2×1',
  '2x2': '2×2',
  '3x2': '3×2',
  '3x3': '3×3'
}))

const getScrollModeLabels = createLocalizedCatalog<Record<SessionGridScrollMode, string>>(() => ({
  row: translate('auto.components.session.grid.SessionGridToolbar.816c044c89', 'Row by row'),
  page: translate('auto.components.session.grid.SessionGridToolbar.11c7b51380', 'Page by page'),
  free: translate('auto.components.session.grid.SessionGridToolbar.5f1c42d996', 'Free scroll')
}))

const getWheelTargetLabels = createLocalizedCatalog<Record<SessionGridWheelTarget, string>>(() => ({
  auto: translate('auto.components.session.grid.SessionGridToolbar.8909cc10c3', 'Auto'),
  terminal: translate('auto.components.session.grid.SessionGridToolbar.33561c90fb', 'Terminal'),
  grid: translate('auto.components.session.grid.SessionGridToolbar.b2bd7400d7', 'Grid')
}))

function WheelTargetHint({ target }: { target: SessionGridWheelTarget }): React.JSX.Element {
  if (target === 'auto') {
    return (
      <span>
        {translate(
          'auto.components.session.grid.SessionGridToolbar.e84bece7ac',
          'Terminal until its end, then the grid'
        )}
      </span>
    )
  }
  const shift = navigator.userAgent.includes('Mac') ? '⇧' : 'Shift'
  return (
    <span className="inline-flex items-center gap-1">
      <ShortcutKeyCombo keys={[shift]} keyCapClassName="min-w-5 px-1 py-0 text-[10px]" />
      <span>
        {translate(
          'auto.components.session.grid.SessionGridToolbar.859362a60c',
          '+ wheel scrolls the {{value0}}',
          {
            value0:
              target === 'terminal'
                ? translate('auto.components.session.grid.SessionGridToolbar.c3a3a9b070', 'grid')
                : translate(
                    'auto.components.session.grid.SessionGridToolbar.a83c6228b3',
                    'terminal'
                  )
          }
        )}
      </span>
    </span>
  )
}

/** One notch of the stepper; the slider it replaces moved in twentieths nobody could read. */
const ZOOM_STEP = 0.1

function formatZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`
}

/** The setter clamps; this only decides what one press asks for, rounded off float drift. */
function steppedZoom(zoom: number, direction: 1 | -1): number {
  return Math.round((zoom + direction * ZOOM_STEP) * 100) / 100
}

/**
 * Zoom as a stepper that shows its value and resets from the middle. Lives in the toolbar
 * only from 1024 px up; the same three actions sit in the view menu at every width, so
 * narrowing the window hides nothing the user cannot still reach.
 */
export function SessionGridZoomStepper({ className }: { className?: string }): React.JSX.Element {
  const zoom = useAppStore((s) => s.sessionsGridZoom)
  const setSessionsGridZoom = useAppStore((s) => s.setSessionsGridZoom)
  return (
    <div
      role="group"
      aria-label={translate('auto.components.session.grid.SessionGridViewMenu.zoom', 'Zoom')}
      className={cn(
        'inline-flex h-7 shrink-0 items-stretch overflow-hidden rounded-md border border-border/80 bg-background/50',
        className
      )}
    >
      <Button
        variant="ghost"
        size="icon-xs"
        data-testid="session-grid-zoom-out"
        className="h-full w-6 rounded-none text-muted-foreground hover:text-foreground"
        disabled={zoom <= SESSION_GRID_ZOOM_MIN}
        onClick={() => setSessionsGridZoom(steppedZoom(zoom, -1))}
        aria-label={translate(
          'auto.components.session.grid.SessionGridViewMenu.zoomOut',
          'Zoom out'
        )}
      >
        <Minus className="size-3" />
      </Button>
      <button
        type="button"
        data-testid="session-grid-zoom-reset"
        onClick={() => setSessionsGridZoom(SESSION_GRID_ZOOM_DEFAULT)}
        title={translate(
          'auto.components.session.grid.SessionGridViewMenu.zoomReset',
          'Reset zoom'
        )}
        className="min-w-11 border-x border-border/60 px-1.5 font-mono text-[11px] tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {formatZoom(zoom)}
      </button>
      <Button
        variant="ghost"
        size="icon-xs"
        data-testid="session-grid-zoom-in"
        className="h-full w-6 rounded-none text-muted-foreground hover:text-foreground"
        disabled={zoom >= SESSION_GRID_ZOOM_MAX}
        onClick={() => setSessionsGridZoom(steppedZoom(zoom, 1))}
        aria-label={translate('auto.components.session.grid.SessionGridViewMenu.zoomIn', 'Zoom in')}
      >
        <Plus className="size-3" />
      </Button>
    </div>
  )
}

const SECTION_LABEL_CLASS =
  'text-[11px] font-semibold uppercase tracking-wider text-muted-foreground'

/**
 * Everything that shapes the view and is set once in a while: layout, zoom, vacant slots,
 * hidden cards, scroll and wheel. One menu, so the toolbar shows one button for the concept
 * instead of the three controls (a dropdown, an eye and a slider) it used to spend on it.
 */
export function SessionGridViewMenu({
  hiddenCount,
  revealHidden,
  onToggleReveal,
  className
}: {
  hiddenCount: number
  revealHidden: boolean
  onToggleReveal: () => void
  className?: string
}): React.JSX.Element {
  const preset = useAppStore((s) => s.sessionsGridPreset)
  const setSessionsGridPreset = useAppStore((s) => s.setSessionsGridPreset)
  const zoom = useAppStore((s) => s.sessionsGridZoom)
  const setSessionsGridZoom = useAppStore((s) => s.setSessionsGridZoom)
  const showEmpty = useAppStore((s) => s.sessionsGridShowEmpty)
  const toggleSessionsGridShowEmpty = useAppStore((s) => s.toggleSessionsGridShowEmpty)
  const scrollMode = useAppStore((s) => s.sessionsGridScrollMode)
  const setSessionsGridScrollMode = useAppStore((s) => s.setSessionsGridScrollMode)
  const wheelTarget = useAppStore((s) => s.sessionsGridWheelTarget)
  const setSessionsGridWheelTarget = useAppStore((s) => s.setSessionsGridWheelTarget)
  // Why prevent the select: a checkbox or stepper row is adjusted, not chosen — closing on
  // every press would make "zoom in twice" a three-click affair.
  const keepOpen = (event: Event): void => event.preventDefault()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          data-testid="session-grid-view-menu"
          aria-label={translate('auto.components.session.grid.SessionGridViewMenu.trigger', 'View')}
          className={cn(
            'h-7 gap-1.5 px-2 font-mono text-xs border-border/80 bg-background/50 @max-xl/toolbar:w-7 @max-xl/toolbar:px-0',
            className
          )}
        >
          <LayoutGrid className="size-3.5 text-muted-foreground" />
          <span className="@max-2xl/toolbar:!hidden">{getPresetLabels()[preset]}</span>
          <ChevronDown className="size-3 text-muted-foreground @max-xl/toolbar:!hidden" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuLabel className={SECTION_LABEL_CLASS}>
          {translate('auto.components.session.grid.SessionGridToolbar.5931c68e4d', 'Grid Layout')}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={preset}
          onValueChange={(value) => setSessionsGridPreset(value as SessionGridLayoutPreset)}
        >
          {SESSION_GRID_PRESETS.map((option) => (
            <DropdownMenuRadioItem key={option} value={option} className="font-mono text-xs">
              {getPresetLabels()[option]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className={cn(SECTION_LABEL_CLASS, 'flex items-center')}>
          {translate('auto.components.session.grid.SessionGridViewMenu.zoom', 'Zoom')}
          <span className="ml-auto font-mono font-normal tabular-nums normal-case tracking-normal">
            {formatZoom(zoom)}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuItem
          data-testid="session-grid-view-zoom-in"
          disabled={zoom >= SESSION_GRID_ZOOM_MAX}
          onSelect={(event) => {
            keepOpen(event)
            setSessionsGridZoom(steppedZoom(zoom, 1))
          }}
          className="text-xs"
        >
          <Plus />
          {translate('auto.components.session.grid.SessionGridViewMenu.zoomIn', 'Zoom in')}
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="session-grid-view-zoom-out"
          disabled={zoom <= SESSION_GRID_ZOOM_MIN}
          onSelect={(event) => {
            keepOpen(event)
            setSessionsGridZoom(steppedZoom(zoom, -1))
          }}
          className="text-xs"
        >
          <Minus />
          {translate('auto.components.session.grid.SessionGridViewMenu.zoomOut', 'Zoom out')}
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="session-grid-view-zoom-reset"
          disabled={zoom === SESSION_GRID_ZOOM_DEFAULT}
          onSelect={(event) => {
            keepOpen(event)
            setSessionsGridZoom(SESSION_GRID_ZOOM_DEFAULT)
          }}
          className="text-xs"
        >
          {translate('auto.components.session.grid.SessionGridViewMenu.zoomReset', 'Reset zoom')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={showEmpty}
          data-testid="session-grid-show-empty"
          onCheckedChange={toggleSessionsGridShowEmpty}
          onSelect={keepOpen}
          className="text-xs"
        >
          {translate(
            'auto.components.session.grid.SessionGridToolbar.a28cc8ef24',
            'Show empty grid slots'
          )}
        </DropdownMenuCheckboxItem>
        {/* Why never unmounted: the reveal mode's only surface; a checkbox that vanished at
            zero would take the mode's off switch with it. Disabled instead, with its count. */}
        <DropdownMenuCheckboxItem
          checked={revealHidden}
          disabled={hiddenCount === 0}
          data-testid="session-grid-reveal-hidden"
          data-count={hiddenCount}
          onCheckedChange={onToggleReveal}
          onSelect={keepOpen}
          className="text-xs"
        >
          {translate(
            'auto.components.session.grid.SessionGridViewMenu.showHidden',
            'Show hidden sessions'
          )}
          <FilterOptionCount count={hiddenCount} />
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className={SECTION_LABEL_CLASS}>
          {translate(
            'auto.components.session.grid.SessionGridToolbar.1f61e1b041',
            'Scroll Behavior'
          )}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={scrollMode}
          onValueChange={(value) => setSessionsGridScrollMode(value as SessionGridScrollMode)}
        >
          {SESSION_GRID_SCROLL_MODES.map((mode) => (
            <DropdownMenuRadioItem key={mode} value={mode} className="text-xs">
              {getScrollModeLabels()[mode]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className={SECTION_LABEL_CLASS}>
          {translate('auto.components.session.grid.SessionGridToolbar.c525d4f2b3', 'Mouse Wheel')}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={wheelTarget}
          onValueChange={(value) => setSessionsGridWheelTarget(value as SessionGridWheelTarget)}
        >
          {SESSION_GRID_WHEEL_TARGETS.map((target) => (
            <DropdownMenuRadioItem
              key={target}
              value={target}
              className="flex flex-col items-start gap-0.5 text-xs"
            >
              <span>{getWheelTargetLabels()[target]}</span>
              <span className="text-[10px] font-normal text-muted-foreground">
                <WheelTargetHint target={target} />
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

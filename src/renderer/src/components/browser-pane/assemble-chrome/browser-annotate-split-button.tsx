import {
  Check,
  ChevronDown,
  Copy,
  Crosshair,
  MessageSquarePlus,
  PenTool,
  Trash2
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type { GrabIntent } from '../../../../../shared/browser/element-grab/browser-grab-types'
import { MarkupDrawHintPopover, useMarkupDrawHintState } from '../annotate/markup-draw-hint-popover'

/** The in-guest element picker, driving both Grab (copy) and Annotate (comment). */
export type BrowserChromeElementTools = {
  /** The intent the picker is armed for right now, or null when it is idle. */
  activeIntent: GrabIntent | null
  onStartIntent: (intent: GrabIntent) => void
  disabled: boolean
  grabShortcutLabel: string
  /** Omitted where the annotate chord isn't wired (the workspace doc preview). */
  annotateShortcutLabel?: string
  annotationCount: number
}

export type BrowserChromeMarkupTool = {
  active: boolean
  disabled: boolean
  onToggle: () => void
  /** Only the owning visible browser pane may consume the discovery hint; hidden panes misplace it and previews would spend it prematurely. */
  canShowDiscoveryHint: boolean
}

export type BrowserChromeNoteActions = {
  onCopyAll: () => void
  onClear: () => void
}

function MenuToolRow({
  icon: Icon,
  label,
  shortcut,
  checked,
  disabled,
  onSelect
}: {
  icon: LucideIcon
  label: string
  shortcut?: string
  checked?: boolean
  disabled?: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={onSelect}
      {...(checked === undefined ? {} : { role: 'menuitemcheckbox', 'aria-checked': checked })}
    >
      <Icon className="size-3.5" />
      {label}
      {/* Why trailing: a leading check column would push these icon rows out of line. */}
      <span className="ml-auto flex items-center gap-2">
        {checked ? <Check className="size-3.5 text-foreground" /> : null}
        {shortcut ? <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut> : null}
      </span>
    </DropdownMenuItem>
  )
}

/** Grab, Annotate and Draw are one mode with three flavours: Annotate on the button, the rest in its menu. */
export function BrowserAnnotateSplitButton({
  tools,
  markup,
  notes,
  compact,
  showTourAnchors
}: {
  tools: BrowserChromeElementTools
  markup: BrowserChromeMarkupTool
  notes?: BrowserChromeNoteActions | null
  /** Narrow rows drop the label; the icon and count stay. */
  compact: boolean
  showTourAnchors: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const { showHint, dismissHint } = useMarkupDrawHintState(
    markup.canShowDiscoveryHint,
    !markup.disabled && !markup.active
  )
  const annotateLabel = t(
    'auto.components.browser.pane.BrowserPane.fc9be38f6f',
    'Annotate page element'
  )
  const grabLabel = t('auto.components.browser.pane.BrowserPane.fdfc7fe0ef', 'Grab page element')
  const drawLabel = t('auto.components.browser-pane.markup.drawButton', 'Draw on screenshot')

  const mode = markup.active
    ? { icon: PenTool, label: t('browser.toolbar.draw', 'Draw') }
    : tools.activeIntent === 'copy'
      ? { icon: Crosshair, label: t('browser.toolbar.grab', 'Grab') }
      : { icon: MessageSquarePlus, label: t('browser.toolbar.annotate', 'Annotate') }
  const active = markup.active || tools.activeIntent !== null
  const ModeIcon = mode.icon

  // Clicking while armed stops that tool, so the button is always the way back out.
  const onPrimary = (): void => {
    if (markup.active) {
      markup.onToggle()
    } else if (tools.activeIntent) {
      tools.onStartIntent(tools.activeIntent)
    } else {
      tools.onStartIntent('annotate')
    }
  }
  const startDraw = (): void => {
    dismissHint()
    markup.onToggle()
  }
  const hasNotes = Boolean(notes) && tools.annotationCount > 0
  const menuHasActions = !tools.disabled || !markup.disabled || hasNotes
  const primaryTooltip = active
    ? mode.label
    : tools.annotateShortcutLabel
      ? t(
          'auto.components.browser.pane.BrowserPane.cc4a071d3a',
          'Annotate page element ({{value0}})',
          { value0: tools.annotateShortcutLabel }
        )
      : annotateLabel

  return (
    <MarkupDrawHintPopover open={showHint} onDismiss={dismissHint} onStart={startDraw}>
      <span
        className={cn(
          'flex shrink-0 rounded-md',
          showHint && 'ring-2 ring-ring/45 ring-offset-1 ring-offset-background'
        )}
        {...(showTourAnchors
          ? { 'data-contextual-tour-target': 'browser-annotation-control' }
          : {})}
      >
        <ButtonGroup>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={active ? 'default' : 'outline'}
                size="sm"
                onClick={onPrimary}
                disabled={!active && tools.disabled}
                aria-label={annotateLabel}
                aria-pressed={active}
              >
                <ModeIcon />
                {compact ? null : <span>{mode.label}</span>}
                {tools.annotationCount > 0 ? (
                  <span
                    className={cn(
                      'flex min-w-4 items-center justify-center rounded-full px-1 text-3xs leading-4 font-semibold',
                      active
                        ? 'bg-primary-foreground text-primary'
                        : 'bg-primary text-primary-foreground'
                    )}
                  >
                    {tools.annotationCount}
                  </span>
                ) : null}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {primaryTooltip}
            </TooltipContent>
          </Tooltip>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant={active ? 'default' : 'outline'}
                size="icon-sm"
                disabled={!menuHasActions}
                aria-label={t('browser.toolbar.annotateOptions', 'More annotate tools')}
              >
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <MenuToolRow
                icon={MessageSquarePlus}
                label={annotateLabel}
                shortcut={tools.annotateShortcutLabel}
                checked={tools.activeIntent === 'annotate'}
                disabled={tools.disabled}
                onSelect={() => tools.onStartIntent('annotate')}
              />
              <MenuToolRow
                icon={Crosshair}
                label={grabLabel}
                shortcut={tools.grabShortcutLabel}
                checked={tools.activeIntent === 'copy'}
                disabled={tools.disabled}
                onSelect={() => tools.onStartIntent('copy')}
              />
              <MenuToolRow
                icon={PenTool}
                label={drawLabel}
                checked={markup.active}
                disabled={markup.disabled}
                onSelect={startDraw}
              />
              {notes && hasNotes ? (
                <>
                  <DropdownMenuSeparator />
                  <MenuToolRow
                    icon={Copy}
                    label={t('browser.toolbar.copyAllNotes', 'Copy all notes')}
                    onSelect={notes.onCopyAll}
                  />
                  <MenuToolRow
                    icon={Trash2}
                    label={t('browser.toolbar.clearNotes', 'Clear notes')}
                    onSelect={notes.onClear}
                  />
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </ButtonGroup>
      </span>
    </MarkupDrawHintPopover>
  )
}

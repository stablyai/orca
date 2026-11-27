import { Ellipsis, Redo2, Trash2, Type, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import {
  MARKUP_COLORS,
  MARKUP_FONT_SIZES,
  MARKUP_WIDTHS,
  type MarkupTool
} from '../drawing/markup-drawing-model'
import { markupToolItems, type MarkupToolbarProps } from '../markup-tools/MarkupToolbar'

/** Kept in the row; the rest of the drawing tools sit in the ⋯ menu so the palette stays one line. */
const ROW_TOOLS: readonly MarkupTool[] = ['pen', 'highlight', 'arrow', 'rect']
/** A narrow palette keeps only Pen in the row (plus the selected tool). */
const COMPACT_ROW_TOOLS: readonly MarkupTool[] = ['pen']

function PaletteIconButton({
  label,
  pressed,
  disabled,
  onClick,
  children
}: {
  label: string
  pressed?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          // A muted fill: the palette's active tool keeps the stronger signal.
          variant={pressed ? 'secondary' : 'ghost'}
          size="icon-xs"
          disabled={disabled}
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent data-annotate-palette-tooltip="" side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** How much of Draw's toolbar fits: everything, a short row plus ⋯, or Pen + the selected tool plus ⋯. */
export type MarkupPaletteDensity = 'full' | 'row' | 'compact'

/** Draw's markup tools sized for the annotate palette, folding into ⋯ only when they don't fit. */
export function MarkupPaletteTools({
  tool,
  onToolChange,
  color,
  onColorChange,
  width,
  onWidthChange,
  fontSize,
  onFontSizeChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClear,
  canClear = canUndo || canRedo,
  density = 'full'
}: MarkupToolbarProps & {
  density?: MarkupPaletteDensity
  /** False on an empty canvas: there is nothing to clear, even with redo history. */
  canClear?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const items = markupToolItems(t)
  const compact = density === 'compact'
  const full = density === 'full'
  // The selected tool always stays visible, taking the last row slot when it lives in the menu.
  const baseRow = compact ? COMPACT_ROW_TOOLS : ROW_TOOLS
  const rowKinds = full
    ? items.map((item) => item.kind)
    : baseRow.includes(tool)
      ? baseRow
      : compact
        ? [...baseRow, tool]
        : [...baseRow.slice(0, -1), tool]
  const rowItems = rowKinds.flatMap((kind) => items.filter((item) => item.kind === kind))
  const menuItems = items.filter((item) => !rowKinds.includes(item.kind))
  const moreLabel = t('browser.annotatePalette.moreDrawTools', 'More drawing tools')
  const styleLabel = t('auto.components.browser-pane.markup.style', 'Color and thickness')
  const fontSizeLabel = t('auto.components.browser-pane.markup.fontSize', 'Font size')

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-0.5">
      {rowItems.map((item) => (
        <PaletteIconButton
          key={item.kind}
          label={item.label}
          pressed={tool === item.kind}
          onClick={() => onToolChange(item.kind)}
        >
          <item.icon className="size-3.5" />
        </PaletteIconButton>
      ))}
      {full ? null : (
        <DropdownMenu modal={false}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-xs" aria-label={moreLabel}>
                  <Ellipsis className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent data-annotate-palette-tooltip="" side="bottom" sideOffset={6}>
              {moreLabel}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" side="bottom">
            {menuItems.map((item) => (
              <DropdownMenuItem key={item.kind} onSelect={() => onToolChange(item.kind)}>
                <item.icon className="size-3.5" />
                {item.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            {compact ? (
              <DropdownMenuItem disabled={!canUndo} onSelect={onUndo}>
                <Undo2 className="size-3.5" />
                {t('auto.components.browser-pane.markup.undo', 'Undo')}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem disabled={!canRedo} onSelect={onRedo}>
              <Redo2 className="size-3.5" />
              {t('auto.components.browser-pane.markup.redo', 'Redo')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canClear} onSelect={onClear}>
              <Trash2 className="size-3.5" />
              {t('auto.components.browser-pane.markup.clear', 'Clear all')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {compact ? null : <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />}
      <Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button type="button" variant="ghost" size="icon-xs" aria-label={styleLabel}>
                <span
                  className="size-3.5 rounded-full border border-border"
                  style={{ backgroundColor: color }}
                />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent data-annotate-palette-tooltip="" side="bottom" sideOffset={6}>
            {styleLabel}
          </TooltipContent>
        </Tooltip>
        <PopoverContent side="bottom" align="start" className="w-auto">
          <div className="flex flex-wrap gap-1">
            {MARKUP_COLORS.map((swatch) => (
              <button
                key={swatch}
                type="button"
                aria-label={swatch}
                onClick={() => onColorChange(swatch)}
                className={cn(
                  'size-6 rounded-full border',
                  color === swatch ? 'border-ring ring-1 ring-ring' : 'border-border'
                )}
                style={{ backgroundColor: swatch }}
              />
            ))}
          </div>
          <div className="mt-2 flex items-center gap-1">
            {MARKUP_WIDTHS.map((option) => (
              <button
                key={option}
                type="button"
                aria-label={t('auto.components.browser-pane.markup.widthOption', '{{value0}} px', {
                  value0: option
                })}
                onClick={() => onWidthChange(option)}
                className={cn(
                  'flex h-6 flex-1 items-center justify-center rounded-sm border',
                  width === option ? 'border-ring bg-accent' : 'border-border hover:bg-accent/50'
                )}
              >
                <span
                  className="rounded-full bg-foreground"
                  style={{ width: option + 2, height: option + 2 }}
                />
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      {/* Font size only matters for the Text tool. */}
      {tool === 'text' ? (
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button type="button" variant="ghost" size="xs" aria-label={fontSizeLabel}>
                  <Type className="size-3.5" />
                  <span className="tabular-nums">{fontSize}</span>
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent data-annotate-palette-tooltip="" side="bottom" sideOffset={6}>
              {fontSizeLabel}
            </TooltipContent>
          </Tooltip>
          <PopoverContent side="bottom" align="start" className="w-auto">
            <div className="flex items-center gap-1">
              {MARKUP_FONT_SIZES.map((size) => (
                <button
                  key={size}
                  type="button"
                  aria-label={t(
                    'auto.components.browser-pane.markup.widthOption',
                    '{{value0}} px',
                    {
                      value0: size
                    }
                  )}
                  onClick={() => onFontSizeChange(size)}
                  className={cn(
                    'flex h-6 min-w-7 items-center justify-center rounded-sm border px-1 text-2xs tabular-nums',
                    fontSize === size ? 'border-ring bg-accent' : 'border-border hover:bg-accent/50'
                  )}
                >
                  {size}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
      {/* Narrow palettes keep Undo in ⋯ (and on ⌘Z). */}
      {compact ? null : (
        <PaletteIconButton
          label={t('auto.components.browser-pane.markup.undo', 'Undo')}
          disabled={!canUndo}
          onClick={onUndo}
        >
          <Undo2 className="size-3.5" />
        </PaletteIconButton>
      )}
      {full ? (
        <>
          <PaletteIconButton
            label={t('auto.components.browser-pane.markup.redo', 'Redo')}
            disabled={!canRedo}
            onClick={onRedo}
          >
            <Redo2 className="size-3.5" />
          </PaletteIconButton>
          <PaletteIconButton
            label={t('auto.components.browser-pane.markup.clear', 'Clear all')}
            disabled={!canClear}
            onClick={onClear}
          >
            <Trash2 className="size-3.5" />
          </PaletteIconButton>
        </>
      ) : null}
    </div>
  )
}

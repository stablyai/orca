import type { ReactNode } from 'react'
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Clock,
  Ellipsis,
  Loader2,
  MoveDown,
  MoveUp,
  Play,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { IpynbCellKind } from './ipynb-parse'

const CELL_KINDS: readonly IpynbCellKind[] = ['code', 'markdown', 'raw']

function cellKindLabel(kind: IpynbCellKind): string {
  return kind === 'code'
    ? translate('auto.components.editor.IpynbViewer.7005960d73', 'Code')
    : kind === 'markdown'
      ? translate('auto.components.editor.IpynbViewer.1833dbbc43', 'Markdown')
      : translate('auto.components.editor.IpynbViewer.3e4cbf15ea', 'Raw')
}

export function IpynbToolbarButton({
  label,
  disabled = false,
  shortcut,
  onClick,
  children
}: {
  label: string
  disabled?: boolean
  shortcut?: ShortcutKeyComboDetails
  onClick: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        <span className="flex items-center gap-2">
          <span>{label}</span>
          {shortcut && shortcut.keys.length > 0 ? (
            <ShortcutKeyCombo keys={shortcut.keys} doubleTap={shortcut.doubleTap} />
          ) : null}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

export type IpynbRunState = 'idle' | 'queued' | 'running'

/** VS Code-style gutter: a fixed `[n]` count with a run button slot below it, shown on hover or focus. */
export function IpynbRunPrompt({
  executionCount,
  state,
  duration,
  onRun
}: {
  executionCount: number | null
  state: IpynbRunState
  /** How long the last run took, once it has finished. */
  duration: string | null
  onRun: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center">
      {/* h-5 matches one code line, so the count sits on the first line's centre. */}
      <span className="flex h-5 items-center font-mono text-[11px] text-muted-foreground">
        [{state === 'idle' ? (executionCount ?? ' ') : '*'}]
      </span>
      {/* Why: `invisible` keeps the slot's box, so revealing the button never moves anything. */}
      <div
        className={cn(
          state === 'idle' && 'invisible group-focus-within:visible group-hover:visible'
        )}
      >
        <IpynbToolbarButton
          label={translate('auto.components.editor.IpynbViewer.859bf9fc21', 'Run cell')}
          disabled={state !== 'idle'}
          onClick={onRun}
        >
          {state === 'running' ? (
            <Loader2 className="animate-spin" />
          ) : state === 'queued' ? (
            <Clock />
          ) : (
            <Play />
          )}
        </IpynbToolbarButton>
      </div>
      {duration ? (
        <span className="font-mono text-[10px] text-muted-foreground">{duration}</span>
      ) : null}
    </div>
  )
}

export function IpynbCellToolbar({
  kind,
  canMoveUp,
  canMoveDown,
  onKindChange,
  onInsert,
  onMove,
  onDelete
}: {
  kind: IpynbCellKind
  canMoveUp: boolean
  canMoveDown: boolean
  onKindChange: (kind: IpynbCellKind) => void
  onInsert: (offset: 0 | 1, kind: IpynbCellKind) => void
  onMove: (direction: -1 | 1) => void
  onDelete: () => void
}): React.JSX.Element {
  return (
    <div className="absolute -top-2 right-1 z-10 flex items-center rounded-md border border-border bg-background opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100">
      <IpynbToolbarButton
        label={translate('auto.components.editor.IpynbViewer.fd8ac707bc', 'Move cell up')}
        disabled={!canMoveUp}
        onClick={() => onMove(-1)}
      >
        <MoveUp />
      </IpynbToolbarButton>
      <IpynbToolbarButton
        label={translate('auto.components.editor.IpynbViewer.27e064e2db', 'Move cell down')}
        disabled={!canMoveDown}
        onClick={() => onMove(1)}
      >
        <MoveDown />
      </IpynbToolbarButton>
      <IpynbToolbarButton
        label={translate('auto.components.editor.IpynbViewer.781abd6926', 'Delete cell')}
        onClick={onDelete}
      >
        <Trash2 />
      </IpynbToolbarButton>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={translate(
                  'auto.components.editor.IpynbViewer.8dbe39a152',
                  'More cell actions'
                )}
              >
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate('auto.components.editor.IpynbViewer.8dbe39a152', 'More cell actions')}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onInsert(0, 'code')}>
            <ArrowUpToLine />
            {translate('auto.components.editor.IpynbViewer.53b839b8a0', 'Insert code cell above')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onInsert(1, 'code')}>
            <ArrowDownToLine />
            {translate('auto.components.editor.IpynbViewer.b4208cad7e', 'Insert code cell below')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onInsert(0, 'markdown')}>
            <ArrowUpToLine />
            {translate(
              'auto.components.editor.IpynbViewer.ffc1ac2699',
              'Insert markdown cell above'
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onInsert(1, 'markdown')}>
            <ArrowDownToLine />
            {translate(
              'auto.components.editor.IpynbViewer.b42f6a9547',
              'Insert markdown cell below'
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>
            {translate('auto.components.editor.IpynbViewer.fa8fd99cf1', 'Cell type')}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={kind}
            onValueChange={(value) => {
              const nextKind = CELL_KINDS.find((candidate) => candidate === value)
              if (nextKind) {
                onKindChange(nextKind)
              }
            }}
          >
            {CELL_KINDS.map((candidate) => (
              <DropdownMenuRadioItem key={candidate} value={candidate}>
                {cellKindLabel(candidate)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

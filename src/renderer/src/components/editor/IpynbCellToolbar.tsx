import type { ReactNode } from 'react'
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Braces,
  FileCode2,
  Loader2,
  MoveDown,
  MoveUp,
  Play,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import type { IpynbCell, IpynbCellKind } from './ipynb-parse'

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
          size="icon"
          className="size-7"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
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

export function IpynbCellToolbar({
  cell,
  index,
  running,
  canMoveUp,
  canMoveDown,
  onRun,
  onKindChange,
  onInsertAbove,
  onInsertBelow,
  onMoveUp,
  onMoveDown,
  onDelete
}: {
  cell: IpynbCell
  index: number
  running: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onRun: () => void
  onKindChange: (kind: IpynbCellKind) => void
  onInsertAbove: (kind: IpynbCellKind) => void
  onInsertBelow: (kind: IpynbCellKind) => void
  onMoveUp: () => void
  onMoveDown: () => void
  onDelete: () => void
}): React.JSX.Element {
  const Icon = cell.kind === 'code' ? Play : cell.kind === 'markdown' ? FileCode2 : Braces
  const executionLabel = cell.kind === 'code' ? `In [${cell.executionCount ?? ' '}]:` : cell.kind
  return (
    <div className="flex items-center gap-2 border-b border-border/50 bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground">
      <Icon className="size-3.5" />
      <span className="font-mono">{executionLabel}</span>
      <select
        value={cell.kind}
        onChange={(event) => onKindChange(event.target.value as IpynbCellKind)}
        className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground"
      >
        <option value="code">
          {translate('auto.components.editor.IpynbViewer.7005960d73', 'Code')}
        </option>
        <option value="markdown">
          {translate('auto.components.editor.IpynbViewer.1833dbbc43', 'Markdown')}
        </option>
        <option value="raw">
          {translate('auto.components.editor.IpynbViewer.3e4cbf15ea', 'Raw')}
        </option>
      </select>
      {cell.kind === 'code' ? (
        <IpynbToolbarButton
          label={translate('auto.components.editor.IpynbViewer.859bf9fc21', 'Run cell')}
          disabled={running}
          onClick={onRun}
        >
          {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
        </IpynbToolbarButton>
      ) : null}
      <IpynbToolbarButton
        label={translate('auto.components.editor.IpynbViewer.fd8ac707bc', 'Move cell up')}
        disabled={!canMoveUp}
        onClick={onMoveUp}
      >
        <MoveUp className="size-3.5" />
      </IpynbToolbarButton>
      <IpynbToolbarButton
        label={translate('auto.components.editor.IpynbViewer.27e064e2db', 'Move cell down')}
        disabled={!canMoveDown}
        onClick={onMoveDown}
      >
        <MoveDown className="size-3.5" />
      </IpynbToolbarButton>
      <IpynbToolbarButton
        label={translate('auto.components.editor.IpynbViewer.53b839b8a0', 'Insert code cell above')}
        onClick={() => onInsertAbove('code')}
      >
        <ArrowUpToLine className="size-3.5" />
      </IpynbToolbarButton>
      <IpynbToolbarButton
        label={translate('auto.components.editor.IpynbViewer.b4208cad7e', 'Insert code cell below')}
        onClick={() => onInsertBelow('code')}
      >
        <ArrowDownToLine className="size-3.5" />
      </IpynbToolbarButton>
      <IpynbToolbarButton
        label={translate(
          'auto.components.editor.IpynbViewer.ffc1ac2699',
          'Insert markdown cell above'
        )}
        onClick={() => onInsertAbove('markdown')}
      >
        <span className="relative size-4">
          <FileCode2 className="absolute left-0.5 top-0.5 size-3" />
          <MoveUp className="absolute -right-0.5 -top-0.5 size-2.5" />
        </span>
      </IpynbToolbarButton>
      <IpynbToolbarButton
        label={translate(
          'auto.components.editor.IpynbViewer.b42f6a9547',
          'Insert markdown cell below'
        )}
        onClick={() => onInsertBelow('markdown')}
      >
        <span className="relative size-4">
          <FileCode2 className="absolute left-0.5 top-0.5 size-3" />
          <MoveDown className="absolute -bottom-0.5 -right-0.5 size-2.5" />
        </span>
      </IpynbToolbarButton>
      <IpynbToolbarButton
        label={translate('auto.components.editor.IpynbViewer.781abd6926', 'Delete cell')}
        onClick={onDelete}
      >
        <Trash2 className="size-3.5" />
      </IpynbToolbarButton>
      <span className="ml-auto font-mono">#{index + 1}</span>
    </div>
  )
}

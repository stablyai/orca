import { Copy, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

export type CustomAgentRowActionsProps = {
  /** Built-ins offer Edit and Duplicate only; Delete/Rename never apply to them. */
  rowKind: 'built-in' | 'custom'
  /** Row label, only for the trigger's accessible name — never rendered as text. */
  agentLabel: string
  disabled?: boolean
  /** When set, Edit renders disabled with this hover reason (a later landing owns it). */
  editDisabledReason?: string
  /** When set, Delete renders disabled with this hover reason (a later landing owns it). */
  deleteDisabledReason?: string
  onEdit: () => void
  onDuplicate: () => void
  onDelete?: () => void
}

export function CustomAgentRowActions({
  rowKind,
  agentLabel,
  disabled,
  editDisabledReason,
  deleteDisabledReason,
  onEdit,
  onDuplicate,
  onDelete
}: CustomAgentRowActionsProps): React.JSX.Element {
  // Delete is a custom-only action; it stays visible-but-disabled while a later
  // landing owns the destructive confirmation, so its absence never reads as "safe".
  const showDelete = rowKind === 'custom' && (Boolean(onDelete) || Boolean(deleteDisabledReason))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          className="size-7 text-muted-foreground hover:text-foreground"
          aria-label={translate(
            'auto.components.settings.CustomAgentRowActions.trigger',
            'Actions for {{agent}}',
            { agent: agentLabel }
          )}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuItem
          disabled={Boolean(editDisabledReason)}
          title={editDisabledReason}
          onSelect={editDisabledReason ? undefined : onEdit}
        >
          <Pencil className="size-3.5" />
          {rowKind === 'built-in'
            ? translate(
                'auto.components.settings.CustomAgentRowActions.editBuiltIn',
                'Edit launch settings'
              )
            : translate('auto.components.settings.CustomAgentRowActions.edit', 'Edit')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onDuplicate}>
          <Copy className="size-3.5" />
          {translate('auto.components.settings.CustomAgentRowActions.duplicate', 'Duplicate')}
        </DropdownMenuItem>
        {showDelete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={Boolean(deleteDisabledReason)}
              title={deleteDisabledReason}
              onSelect={deleteDisabledReason ? undefined : () => onDelete?.()}
            >
              <Trash2 className="size-3.5" />
              {translate('auto.components.settings.CustomAgentRowActions.delete', 'Delete')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

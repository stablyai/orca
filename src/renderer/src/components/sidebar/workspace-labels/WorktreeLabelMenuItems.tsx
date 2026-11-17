import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { Plus, Tag } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type { WorkspaceLabel } from '../../../../../shared/workspace/labels/workspace-labels'

export function WorktreeLabelMenuItems(props: {
  labels: readonly WorkspaceLabel[]
  checkedLabelIds: ReadonlySet<string>
  disabled: boolean
  onToggle: (labelId: string) => void
  onNewLabel: () => void
}) {
  const t = useTranslate()
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={props.disabled}>
        <Tag className="size-3.5" />
        {t('workspaceLabels.menu.labels', 'Labels')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-48">
        {props.labels.map((label) => (
          <DropdownMenuCheckboxItem
            key={label.id}
            checked={props.checkedLabelIds.has(label.id)}
            onCheckedChange={() => props.onToggle(label.id)}
            // Keep the submenu open so several labels can be set in one go.
            onSelect={(event) => event.preventDefault()}
          >
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: label.color }}
            />
            <span className="truncate">{label.name}</span>
          </DropdownMenuCheckboxItem>
        ))}
        {props.labels.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem onSelect={props.onNewLabel}>
          <Plus className="size-3.5" />
          {t('workspaceLabels.menu.newLabel', 'New label…')}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

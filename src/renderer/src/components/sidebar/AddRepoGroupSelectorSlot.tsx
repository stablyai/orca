import { Layers } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import type { ProjectGroup } from '../../../../shared/project-group-types'

const NO_GROUP_VALUE = '__none__'

type AddRepoGroupSelectorSlotProps = {
  projectGroups: readonly ProjectGroup[]
  selectedGroupId: string | null
  onGroupChange: (groupId: string | null) => void
}

export function AddRepoGroupSelectorSlot({
  projectGroups,
  selectedGroupId,
  onGroupChange
}: AddRepoGroupSelectorSlotProps): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">
        <Layers className="mr-1 inline size-3" />
        {translate('components.sidebar.addRepo.groupSelectorLabel', 'Add to group (optional)')}
      </Label>
      <Select
        value={selectedGroupId ?? NO_GROUP_VALUE}
        onValueChange={(value) => onGroupChange(value === NO_GROUP_VALUE ? null : value)}
      >
        <SelectTrigger size="sm" className="w-full text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_GROUP_VALUE} className="text-xs text-muted-foreground">
            {translate('components.sidebar.addRepo.groupSelectorNoGroup', 'No group')}
          </SelectItem>
          {projectGroups.map((group) => (
            <SelectItem key={group.id} value={group.id} className="text-xs">
              {group.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

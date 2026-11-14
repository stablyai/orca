import { Palette } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { normalizeRepoBadgeColor, REPO_COLORS } from '../../../../../../shared/repo-badge-color'

export function ProjectGroupColorMenu({ group }: { group: ProjectGroup }): React.JSX.Element {
  const t = useTranslate()
  const updateProjectGroup = useAppStore((s) => s.updateProjectGroup)
  const color = normalizeRepoBadgeColor(group.color)
  const names = [
    t('auto.components.sidebar.groupColor.gray', 'Gray'),
    t('auto.components.sidebar.groupColor.red', 'Red'),
    t('auto.components.sidebar.groupColor.orange', 'Orange'),
    t('auto.components.sidebar.groupColor.yellow', 'Yellow'),
    t('auto.components.sidebar.groupColor.green', 'Green'),
    t('auto.components.sidebar.groupColor.teal', 'Teal'),
    t('auto.components.sidebar.groupColor.purple', 'Purple'),
    t('auto.components.sidebar.groupColor.pink', 'Pink')
  ]

  const saveColor = async (value: string): Promise<void> => {
    const saved = await updateProjectGroup(
      group.id,
      { color: value === 'none' ? null : value },
      {
        hostId: getRepoExecutionHostId(group)
      }
    )
    if (!saved) {
      toast.error(t('auto.components.sidebar.groupColor.saveFailed', 'Could not save group color'))
    }
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Palette className="size-3.5" />
        {t('auto.components.sidebar.groupColor.label', 'Group color')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup
          value={color ?? 'none'}
          onValueChange={(value) => void saveColor(value)}
        >
          <DropdownMenuRadioItem value="none">
            {t('auto.components.sidebar.groupColor.none', 'No color')}
          </DropdownMenuRadioItem>
          {REPO_COLORS.map((value, index) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <span
                aria-hidden="true"
                className="size-3 shrink-0 rounded-full"
                style={{ backgroundColor: value }}
              />
              {names[index]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

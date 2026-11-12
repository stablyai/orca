// PROJ-MENU part 2: "Give Orca Cloud access to more repositories" moves out of the project list into
// the Add project menu, as one more way to add a project: "From GitHub (Orca Cloud)…".
import React from 'react'
import { Github } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { ProjectComboboxAddProjectMenu } from './ProjectComboboxAddProjectOption'

function FromGitHubItem({ onSelect }: { onSelect: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <Github />
      <span className="truncate">
        {t('components.newWorkspace.cloudOnly.fromGitHub', 'From GitHub (Orca Cloud)…')}
      </span>
    </DropdownMenuItem>
  )
}

/**
 * With an Add project menu and Orca Cloud's access link, the link becomes that menu's last entry and
 * leaves the list. Without the menu (the plain Add project row), the list keeps it.
 */
export function withCloudAddProjectEntry(
  addProjectMenu: ProjectComboboxAddProjectMenu | undefined,
  onMoreCloudAccess: (() => void) | undefined
): {
  addProjectMenu: ProjectComboboxAddProjectMenu | undefined
  listMoreAccess: (() => void) | undefined
} {
  if (!addProjectMenu || !onMoreCloudAccess) {
    return { addProjectMenu, listMoreAccess: onMoreCloudAccess }
  }
  return {
    addProjectMenu: {
      ...addProjectMenu,
      extraItems: (closeMenus) => (
        <FromGitHubItem
          onSelect={() => {
            closeMenus()
            onMoreCloudAccess()
          }}
        />
      )
    },
    listMoreAccess: undefined
  }
}

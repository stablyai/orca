// PROJ-MENU part 2: "Give Orca Cloud access to more repositories" moves out of the project list into
// the Add project menu, in its own "Orca Cloud" group: "Add a GitHub repository…".
import React from 'react'
import { Github } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { ProjectComboboxAddProjectMenu } from './ProjectComboboxAddProjectOption'

function FromGitHubItem({ onSelect }: { onSelect: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {/* Its own group: the header's host picker doesn't apply to Orca Cloud. */}
      <DropdownMenuSeparator />
      <div
        role="presentation"
        className="flex min-h-[26px] items-center py-0.5 pl-2.5 text-2xs font-semibold text-muted-foreground select-none"
      >
        {t('components.newWorkspace.cloudOnly.menuGroup', 'Orca Cloud')}
      </div>
      <DropdownMenuItem onSelect={onSelect}>
        <Github />
        {/* The same words as the composer's link, so both ways in read the same. */}
        <span className="truncate">
          {t('components.newWorkspace.cloudOnly.addRepositoryMenu', 'Add a GitHub repository…')}
        </span>
      </DropdownMenuItem>
    </>
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

// PROJ-MENU part 2: "Give Orca Cloud access to more repositories" moves out of the project list into
// the Add project menu, in its own "Orca Cloud" group: "Add a GitHub repository…".
import React from 'react'
import { Github, Link2 } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { copyExternalLink } from '@/components/open-external/copy-external-link'
import { gitHubInstallLinkSource } from '@/lib/orca-cloud/github-link-sources'
import type { ProjectComboboxAddProjectMenu } from './ProjectComboboxAddProjectOption'

function FromGitHubItem({
  onSelect,
  onCopyLink
}: {
  onSelect: () => void
  onCopyLink: () => void
}): React.JSX.Element {
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
      {/* A menu row can't carry a chevron: the same GitHub page, copied for another browser. */}
      <DropdownMenuItem onSelect={onCopyLink}>
        <Link2 />
        <span className="truncate">
          {t('components.newWorkspace.cloudOnly.copyAddRepositoryLink', 'Copy GitHub link')}
        </span>
      </DropdownMenuItem>
    </>
  )
}

/**
 * The "Orca Cloud" group for any Add project menu: the combobox's Add project row and the folder+
 * button beside the Project label. Undefined without Orca Cloud's access link (Run on isn't Orca Cloud).
 */
export function cloudAddProjectExtraItems(
  onMoreCloudAccess: (() => void) | undefined
): ((closeMenus: () => void) => React.ReactNode) | undefined {
  if (!onMoreCloudAccess) {
    return undefined
  }
  return (closeMenus) => (
    <FromGitHubItem
      onSelect={() => {
        closeMenus()
        onMoreCloudAccess()
      }}
      onCopyLink={() => {
        closeMenus()
        void copyExternalLink(gitHubInstallLinkSource())
      }}
    />
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
    addProjectMenu: { ...addProjectMenu, extraItems: cloudAddProjectExtraItems(onMoreCloudAccess) },
    listMoreAccess: undefined
  }
}

// "Open cloud workspace…" in the Add project menu (sidebar and Landing), in its own "Orca Cloud"
// group: the way to open a cloud workspace the sidebar doesn't show yet.
import React, { useMemo } from 'react'
import { Cloud } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { openCloudWorkspacePicker } from './cloud-workspace-picker-store'
import { useCloudWorkspacesPresent } from './use-cloud-workspaces'

function OpenCloudWorkspaceItem({ onSelect }: { onSelect: () => void }): React.JSX.Element {
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
      <DropdownMenuItem onSelect={onSelect} data-open-cloud-workspace-item="">
        <Cloud />
        <span className="truncate">
          {t('components.cloudWorkspaces.picker.menuItem', 'Open cloud workspace…')}
        </span>
      </DropdownMenuItem>
    </>
  )
}

/** The Add project menu's `extraItems`, or undefined when signed out or without Orca Cloud. */
export function useOpenCloudWorkspaceMenuItems():
  | ((closeMenu: () => void) => React.ReactNode)
  | undefined {
  const present = useCloudWorkspacesPresent()
  return useMemo(
    () =>
      present
        ? (closeMenu: () => void) => (
            <OpenCloudWorkspaceItem
              onSelect={() => {
                closeMenu()
                openCloudWorkspacePicker()
              }}
            />
          )
        : undefined,
    [present]
  )
}

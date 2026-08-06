import type React from 'react'
import { AppWindow, Check, ExternalLink, FolderOpen } from 'lucide-react'
import {
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger
} from '@/components/ui/context-menu'
import { useAppStore } from '@/store'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { OpenInApplicationIcon } from '@/lib/open-in-app-catalog'
import { NO_OPEN_IN_APPLICATIONS } from '@/lib/open-in-application-selection'
import { translate } from '@/i18n/i18n'
import { getOpenWithFileTypeKey } from '../../../../shared/open-with-applications'
import type { OpenWithApplication } from '../../../../shared/types'
import { openFileExplorerPathWithSystemDefault } from './file-explorer-system-open'
import {
  mergeOpenWithMenuEntries,
  NO_OPEN_WITH_APPLICATIONS,
  openPathWithApplication,
  pickAndRegisterOpenWithApplication,
  toggleOpenWithDefault
} from './file-explorer-open-with-actions'

const SYSTEM_DEFAULT_VALUE = 'system-default'

function useOpenWithEntries(): OpenWithApplication[] {
  const openWithApplications = useAppStore(
    (s) => s.settings?.openWithApplications ?? NO_OPEN_WITH_APPLICATIONS
  )
  const openInApplications = useAppStore(
    (s) => s.settings?.openInApplications ?? NO_OPEN_IN_APPLICATIONS
  )
  return mergeOpenWithMenuEntries(openWithApplications, openInApplications)
}

export function FileExplorerOpenWithMenu({
  path,
  connectionId
}: {
  path: string
  connectionId: string | null
}): React.JSX.Element {
  const entries = useOpenWithEntries()
  const openWithDefaults = useAppStore((s) => s.settings?.openWithDefaults)
  const systemDefaultShortcut = useShortcutLabel('fileExplorer.openWithSystemDefault')
  const fileTypeKey = getOpenWithFileTypeKey(path)
  const defaultApplicationId = fileTypeKey ? openWithDefaults?.[fileTypeKey] : undefined

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <FolderOpen />
        {translate('components.right.sidebar.fileExplorerOpenWith.trigger', 'Open With')}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-60">
        <ContextMenuItem onSelect={() => void openFileExplorerPathWithSystemDefault(path)}>
          <AppWindow />
          {translate(
            'components.right.sidebar.fileExplorerOpenWith.systemDefault',
            'System Default App'
          )}
          {systemDefaultShortcut !== 'Unassigned' ? (
            <ContextMenuShortcut>{systemDefaultShortcut}</ContextMenuShortcut>
          ) : null}
        </ContextMenuItem>
        {entries.length > 0 ? <ContextMenuSeparator /> : null}
        {entries.map((entry) => (
          <ContextMenuItem
            key={entry.id}
            onSelect={() => void openPathWithApplication(path, entry, connectionId)}
          >
            <OpenInApplicationIcon application={{ command: entry.command }} size={14} />
            <span className="min-w-0 truncate">{entry.label}</span>
            {entry.id === defaultApplicationId ? <Check className="ml-auto size-3.5" /> : null}
          </ContextMenuItem>
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => {
            void pickAndRegisterOpenWithApplication().then((application) => {
              if (application) {
                void openPathWithApplication(path, application, connectionId)
              }
            })
          }}
        >
          <ExternalLink />
          {translate('components.right.sidebar.fileExplorerOpenWith.choose', 'Choose App…')}
        </ContextMenuItem>
        {fileTypeKey && entries.length > 0 ? (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              {translate(
                'components.right.sidebar.fileExplorerOpenWith.setDefault',
                'Always Open {{type}} With',
                { type: fileTypeKey }
              )}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-56">
              <ContextMenuRadioGroup value={defaultApplicationId ?? SYSTEM_DEFAULT_VALUE}>
                <ContextMenuRadioItem
                  value={SYSTEM_DEFAULT_VALUE}
                  onSelect={() => {
                    const pinned = entries.find((entry) => entry.id === defaultApplicationId)
                    if (pinned) {
                      void toggleOpenWithDefault(path, pinned)
                    }
                  }}
                >
                  {translate(
                    'components.right.sidebar.fileExplorerOpenWith.systemDefault',
                    'System Default App'
                  )}
                </ContextMenuRadioItem>
                {entries.map((entry) => (
                  <ContextMenuRadioItem
                    key={entry.id}
                    value={entry.id}
                    onSelect={() => void toggleOpenWithDefault(path, entry)}
                  >
                    <span className="min-w-0 truncate">{entry.label}</span>
                  </ContextMenuRadioItem>
                ))}
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>
        ) : null}
      </ContextMenuSubContent>
    </ContextMenuSub>
  )
}

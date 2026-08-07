// Right-click menu on the recorder button: which streams the session logs.
import type { ReactNode } from 'react'

import { translate } from '@/i18n/i18n'
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import type {
  BrowserRecorderOptionKey,
  BrowserRecorderOptions
} from '../../../../shared/browser-recorder-automation'

export function BrowserRecorderOptionsMenu({
  options,
  onToggle,
  children
}: {
  options: BrowserRecorderOptions
  onToggle: (key: BrowserRecorderOptionKey, enabled: boolean) => void
  children: ReactNode
}): ReactNode {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuLabel>
          {translate(
            'auto.components.browser.pane.BrowserRecorderOptionsMenu.recordOptionsLabel',
            'Record options'
          )}
        </ContextMenuLabel>
        <ContextMenuSeparator />
        <ContextMenuCheckboxItem
          checked={options.console}
          onCheckedChange={(checked) => onToggle('console', checked)}
          // Why: Radix closes the menu on any item selection — prevent that so
          // the user can flip several toggles before clicking away.
          onSelect={(event) => event.preventDefault()}
        >
          {translate(
            'auto.components.browser.pane.BrowserRecorderOptionsMenu.consoleMessages',
            'Console messages'
          )}
        </ContextMenuCheckboxItem>
        <ContextMenuCheckboxItem
          checked={options.requests}
          onCheckedChange={(checked) => onToggle('requests', checked)}
          onSelect={(event) => event.preventDefault()}
        >
          {translate(
            'auto.components.browser.pane.BrowserRecorderOptionsMenu.networkRequests',
            'Network requests'
          )}
        </ContextMenuCheckboxItem>
        <ContextMenuCheckboxItem
          checked={options.requestDetails}
          disabled={!options.requests}
          onCheckedChange={(checked) => onToggle('requestDetails', checked)}
          onSelect={(event) => event.preventDefault()}
        >
          {translate(
            'auto.components.browser.pane.BrowserRecorderOptionsMenu.requestDetails',
            'Request details'
          )}
        </ContextMenuCheckboxItem>
        <ContextMenuCheckboxItem
          checked={options.storage}
          onCheckedChange={(checked) => onToggle('storage', checked)}
          onSelect={(event) => event.preventDefault()}
        >
          {translate(
            'auto.components.browser.pane.BrowserRecorderOptionsMenu.storageWrites',
            'Storage writes'
          )}
        </ContextMenuCheckboxItem>
        <ContextMenuCheckboxItem
          checked={options.ws}
          onCheckedChange={(checked) => onToggle('ws', checked)}
          onSelect={(event) => event.preventDefault()}
        >
          {translate(
            'auto.components.browser.pane.BrowserRecorderOptionsMenu.webSocketMessages',
            'WebSocket messages'
          )}
        </ContextMenuCheckboxItem>
        <ContextMenuSeparator />
        <ContextMenuLabel className="font-normal text-muted-foreground">
          {translate(
            'auto.components.browser.pane.BrowserRecorderOptionsMenu.rightClickHint',
            'Right-click the record button to change what gets logged.'
          )}
        </ContextMenuLabel>
      </ContextMenuContent>
    </ContextMenu>
  )
}

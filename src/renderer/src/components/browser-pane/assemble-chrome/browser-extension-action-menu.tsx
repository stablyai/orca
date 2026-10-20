import { Pin, PinOff, Settings2, Trash2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { browserExtensionRemovalDescription } from '@/components/browser-extension-removal-description'
import { translate } from '@/i18n/i18n'
import type { BrowserExtensionActionResult } from '../../../../../shared/browser-extension-types'
import type { BrowserExtensionToolbarAction } from '../../../../../shared/browser-extension-toolbar-types'
import { useBrowserExtensionActionContextItems } from './browser-extension-action-context-items'

export type BrowserExtensionMenuEntry =
  | {
      key: string
      label: string
      icon?: LucideIcon
      disabled?: boolean
      destructive?: boolean
      onSelect: () => void
    }
  | { key: string; separator: true }

async function reportFailure(result: Promise<BrowserExtensionActionResult>): Promise<void> {
  const outcome = await result.catch((error: unknown) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : String(error)
  }))
  if (!outcome.ok) {
    toast.error(outcome.error)
  }
}

/** Pin, Options, the extension's own action items, and Remove — shared by right-click and the puzzle menu. */
export function useBrowserExtensionActionMenuEntries(
  profileId: string,
  action: BrowserExtensionToolbarAction
): BrowserExtensionMenuEntry[] {
  const confirm = useConfirmationDialog()
  const contextItems = useBrowserExtensionActionContextItems(profileId, action.extensionId)
  const { extensionId } = action

  const remove = async (): Promise<void> => {
    const confirmed = await confirm({
      title: translate('settings.browser.extensions.removeTitle', 'Remove {{name}}?', {
        name: action.name
      }),
      description: browserExtensionRemovalDescription(action.source),
      confirmLabel: translate('settings.browser.extensions.remove', 'Remove'),
      confirmVariant: 'destructive'
    })
    if (confirmed) {
      await reportFailure(window.api.browser.extensionsRemove({ profileId, extensionId }))
    }
  }

  return [
    {
      key: 'pin',
      label: action.pinned
        ? translate('browser.extensions.unpin', 'Unpin from toolbar')
        : translate('browser.extensions.pin', 'Pin to toolbar'),
      icon: action.pinned ? PinOff : Pin,
      onSelect: () =>
        void reportFailure(
          window.api.browser.extensionsSetPinned({ profileId, extensionId, pinned: !action.pinned })
        )
    },
    ...(action.hasOptionsPage
      ? [
          {
            key: 'options',
            label: translate('settings.browser.extensions.options', 'Options'),
            icon: Settings2,
            onSelect: () =>
              void reportFailure(
                window.api.browser.extensionsOpenOptions({ profileId, extensionId })
              )
          }
        ]
      : []),
    ...(contextItems.length > 0 ? [{ key: 'context-separator', separator: true as const }] : []),
    ...contextItems.map((item) => ({
      key: `context-${item.id}`,
      label: item.label,
      disabled: !item.enabled,
      onSelect: item.onSelect
    })),
    { key: 'remove-separator', separator: true },
    {
      key: 'remove',
      label: translate('browser.extensions.remove', 'Remove…'),
      icon: Trash2,
      destructive: true,
      onSelect: () => void remove()
    }
  ]
}

export function BrowserExtensionDropdownEntries({
  entries
}: {
  entries: BrowserExtensionMenuEntry[]
}): React.JSX.Element {
  return (
    <>
      {entries.map((entry) =>
        'separator' in entry ? (
          <DropdownMenuSeparator key={entry.key} />
        ) : (
          <DropdownMenuItem
            key={entry.key}
            disabled={entry.disabled}
            variant={entry.destructive ? 'destructive' : 'default'}
            onSelect={entry.onSelect}
          >
            {entry.icon ? <entry.icon className="size-3.5" /> : null}
            {entry.label}
          </DropdownMenuItem>
        )
      )}
    </>
  )
}

export function BrowserExtensionContextEntries({
  entries
}: {
  entries: BrowserExtensionMenuEntry[]
}): React.JSX.Element {
  return (
    <>
      {entries.map((entry) =>
        'separator' in entry ? (
          <ContextMenuSeparator key={entry.key} />
        ) : (
          <ContextMenuItem
            key={entry.key}
            disabled={entry.disabled}
            variant={entry.destructive ? 'destructive' : 'default'}
            onSelect={entry.onSelect}
          >
            {entry.icon ? <entry.icon className="size-3.5" /> : null}
            {entry.label}
          </ContextMenuItem>
        )
      )}
    </>
  )
}

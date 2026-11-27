import { Check, Pin, PinOff, Settings2, Trash2, type LucideIcon } from 'lucide-react'

import { toast } from 'sonner'
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { browserExtensionRemovalDescription } from '@/components/browser-pane/assemble-chrome/extensions/browser-extension-removal-description'
import { type Translate, useTranslate } from '@/i18n/use-translate'
import { browserExtensionFailureMessage } from '@/components/settings/browser/extensions/browser-extension-failure-message'
import { cn } from '@/lib/class-names'
import type { BrowserExtensionContextMenuItem } from '../../../../../../shared/browser/extensions/browser-extension-context-menu-types'
import type { BrowserExtensionActionResult } from '../../../../../../shared/browser/extensions/browser-extension-types'
import type { BrowserExtensionToolbarAction } from '../../../../../../shared/browser/extensions/browser-extension-toolbar-types'
import { useBrowserExtensionActionContextMenu } from './browser-extension-action-context-items'
import {
  browserExtensionMenuCheck,
  type BrowserExtensionMenuCheck
} from './browser-extension-menu-check'

export type BrowserExtensionMenuEntry =
  | {
      key: string
      label: string
      icon?: LucideIcon
      /** Set for checkbox and radio items. */
      check?: BrowserExtensionMenuCheck
      disabled?: boolean
      destructive?: boolean
      children?: BrowserExtensionMenuEntry[]
      onSelect: () => void
    }
  | { key: string; separator: true }

function contextMenuEntry(
  item: BrowserExtensionContextMenuItem,
  click: (key: string) => void
): BrowserExtensionMenuEntry {
  const key = `context-${item.key}`
  if (item.type === 'separator') {
    return { key, separator: true }
  }
  return {
    key,
    label: item.title,
    check: browserExtensionMenuCheck(item),
    disabled: !item.enabled,
    children:
      item.children.length > 0
        ? item.children.map((child) => contextMenuEntry(child, click))
        : undefined,
    onSelect: () => click(item.key)
  }
}

async function reportFailure(
  t: Translate,
  result: Promise<BrowserExtensionActionResult>
): Promise<void> {
  const outcome = await result.catch((error: unknown) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : String(error)
  }))
  if (!outcome.ok) {
    toast.error(browserExtensionFailureMessage(t, outcome))
  }
}

/**
 * Pin, Options, the extension's own action items, and Remove — shared by right-click and the puzzle
 * menu. Call it from inside the open menu: the extension's items are fetched on mount.
 */
export function useBrowserExtensionActionMenuEntries(
  profileId: string,
  action: BrowserExtensionToolbarAction,
  browserPageId: string
): BrowserExtensionMenuEntry[] {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const { extensionId } = action
  const contextMenu = useBrowserExtensionActionContextMenu(profileId, extensionId, browserPageId)
  const contextItems = contextMenu
    ? contextMenu.groups.flatMap((group) =>
        group.items.map((item) =>
          contextMenuEntry(
            item,
            (key) =>
              void window.api.browser.extensionsContextMenuClick({
                token: contextMenu.token,
                extensionId: group.extensionId,
                key
              })
          )
        )
      )
    : []

  const remove = async (): Promise<void> => {
    const confirmed = await confirm({
      title: t('settings.browser.extensions.removeTitle', 'Remove {{name}}?', {
        name: action.name
      }),
      description: browserExtensionRemovalDescription(action.source),
      confirmLabel: t('settings.browser.extensions.remove', 'Remove'),
      confirmVariant: 'destructive',
      surface: 'security'
    })
    if (confirmed) {
      await reportFailure(t, window.api.browser.extensionsRemove({ profileId, extensionId }))
    }
  }

  return [
    {
      key: 'pin',
      label: action.pinned
        ? t('browser.extensions.unpin', 'Unpin from toolbar')
        : t('browser.extensions.pin', 'Pin to toolbar'),
      icon: action.pinned ? PinOff : Pin,
      onSelect: () =>
        void reportFailure(
          t,
          window.api.browser.extensionsSetPinned({ profileId, extensionId, pinned: !action.pinned })
        )
    },
    ...(action.hasOptionsPage
      ? [
          {
            key: 'options',
            label: t('settings.browser.extensions.options', 'Options'),
            icon: Settings2,
            onSelect: () =>
              void reportFailure(
                t,
                window.api.browser.extensionsOpenOptions({ profileId, extensionId })
              )
          }
        ]
      : []),
    ...(contextItems.length > 0 ? [{ key: 'context-separator', separator: true as const }] : []),
    ...contextItems,
    { key: 'remove-separator', separator: true },
    {
      key: 'remove',
      label: t('browser.extensions.remove', 'Remove…'),
      icon: Trash2,
      destructive: true,
      onSelect: () => void remove()
    }
  ]
}

type MenuKit = {
  Item: typeof DropdownMenuItem | typeof ContextMenuItem
  Separator: typeof DropdownMenuSeparator | typeof ContextMenuSeparator
  Sub: typeof DropdownMenuSub | typeof ContextMenuSub
  SubTrigger: typeof DropdownMenuSubTrigger | typeof ContextMenuSubTrigger
  SubContent: typeof DropdownMenuSubContent | typeof ContextMenuSubContent
}

const DROPDOWN_KIT: MenuKit = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent
}

const CONTEXT_KIT: MenuKit = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent
}

function MenuEntries({
  entries,
  kit
}: {
  entries: BrowserExtensionMenuEntry[]
  kit: MenuKit
}): React.JSX.Element {
  const { Item, Separator, Sub, SubTrigger, SubContent } = kit
  return (
    <>
      {entries.map((entry) => {
        if ('separator' in entry) {
          return <Separator key={entry.key} />
        }
        const icon = entry.check ? (
          <Check className={cn('size-3.5', !entry.check.checked && 'opacity-0')} />
        ) : entry.icon ? (
          <entry.icon className="size-3.5" />
        ) : null
        return entry.children ? (
          <Sub key={entry.key}>
            <SubTrigger disabled={entry.disabled}>
              {icon}
              {entry.label}
            </SubTrigger>
            <SubContent>
              <MenuEntries entries={entry.children} kit={kit} />
            </SubContent>
          </Sub>
        ) : (
          <Item
            key={entry.key}
            role={entry.check?.role ?? 'menuitem'}
            aria-checked={entry.check?.checked}
            disabled={entry.disabled}
            variant={entry.destructive ? 'destructive' : 'default'}
            onSelect={entry.onSelect}
          >
            {icon}
            {entry.label}
          </Item>
        )
      })}
    </>
  )
}

export function BrowserExtensionDropdownEntries({
  entries
}: {
  entries: BrowserExtensionMenuEntry[]
}): React.JSX.Element {
  return <MenuEntries entries={entries} kit={DROPDOWN_KIT} />
}

export function BrowserExtensionContextEntries({
  entries
}: {
  entries: BrowserExtensionMenuEntry[]
}): React.JSX.Element {
  return <MenuEntries entries={entries} kit={CONTEXT_KIT} />
}

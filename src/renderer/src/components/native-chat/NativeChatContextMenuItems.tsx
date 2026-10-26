import type { RefObject } from 'react'
import { Copy, ExternalLink, FileText, Globe, Quote, Search, Undo2 } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuShortcut } from '@/components/ui/dropdown-menu'
import { formatOptionalPrimaryShortcutLabel } from '@/hooks/useShortcutLabel'
import { useAppStore } from '@/store'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import type { LinkAction } from '@/components/link-actions/link-action-request'
import { buildExternalLinkMenuModel } from '@/components/link-actions/external-link-menu-model'
import { ExternalLinkOpenInSubmenu } from '@/components/link-actions/ExternalLinkMenuItems'
import { translate } from '@/i18n/i18n'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import type { NativeChatContextMenuTarget } from './native-chat-context-menu-target'
import type { NativeChatFileLinkContext } from './native-chat-file-link'
import { resolveNativeChatHttpLinkSourceOwner } from './native-chat-http-link-source-owner'
import { formatNativeChatQuote } from './native-chat-quote-selection'
import type { NativeChatRewindSurface } from './use-native-chat-rewind'

function copyText(text: string): void {
  // Best-effort, as the hover copy buttons are: the clipboard can reject when unfocused.
  window.api.ui.writeClipboardText(text).catch(() => {})
}

/** The rows for what was right-clicked: each reuses the action its hover or click surface runs. */
export function NativeChatContextMenuTargetItems({
  target,
  composerRef,
  rewind,
  linkContext
}: {
  target: NativeChatContextMenuTarget
  composerRef: RefObject<NativeChatComposerHandle | null>
  rewind: NativeChatRewindSurface | undefined
  linkContext: NativeChatFileLinkContext | null
}): React.JSX.Element {
  const { quoteText, link, codeText, messageText, rewindItemId } = target
  const linkRows = link ? [link.primary, link.alternate, ...(link.secondaryActions ?? [])] : []
  return (
    <>
      {quoteText ? (
        <DropdownMenuItem
          onSelect={() => composerRef.current?.appendText(formatNativeChatQuote(quoteText))}
        >
          <Quote />
          {translate('components.native-chat.addSelectionToChat', 'Add to chat')}
        </DropdownMenuItem>
      ) : null}
      {linkRows.map((action) =>
        action ? (
          <DropdownMenuItem key={action.label} onSelect={() => void action.run()}>
            <LinkActionIcon action={action} />
            {action.label}
          </DropdownMenuItem>
        ) : null
      )}
      {link?.kind === 'url' && linkContext ? (
        <NativeChatLinkOpenInSubmenu url={link.destination} worktreeId={linkContext.worktreeId} />
      ) : null}
      {link ? (
        <DropdownMenuItem onSelect={() => copyText(link.destination)}>
          <Copy />
          {link.kind === 'url'
            ? translate(
                'auto.components.terminal.pane.TerminalLinkActionPopover.copyLink',
                'Copy link'
              )
            : translate('auto.components.activity.ActivityThreadContextMenu.copyPath', 'Copy Path')}
        </DropdownMenuItem>
      ) : null}
      {codeText ? (
        <DropdownMenuItem onSelect={() => copyText(codeText)}>
          <Copy />
          {translate('components.native-chat.copyCode', 'Copy code')}
        </DropdownMenuItem>
      ) : null}
      {messageText ? (
        <DropdownMenuItem onSelect={() => copyText(messageText)}>
          <Copy />
          {translate('components.native-chat.copyMessage.copy', 'Copy message')}
        </DropdownMenuItem>
      ) : null}
      {rewindItemId && rewind ? (
        <NativeChatRewindMenuItem itemId={rewindItemId} rewind={rewind} />
      ) : null}
    </>
  )
}

function NativeChatLinkOpenInSubmenu({
  url,
  worktreeId
}: {
  url: string
  worktreeId: string
}): React.JSX.Element | null {
  const installedBrowsers = useAppStore((state) => state.installedBrowsers)
  const sourceOwner = resolveNativeChatHttpLinkSourceOwner(useAppStore.getState(), worktreeId)
  // Routing refuses an unknown owner, so its browser rows would do nothing.
  if (sourceOwner.kind === 'unknown') {
    return null
  }
  // Orca's row comes from the click popover's actions, so whether it could open is moot here.
  const model = buildExternalLinkMenuModel(
    { url, worktreeId, sourceOwner, canOpenOwnedBrowser: false },
    installedBrowsers
  )
  return <ExternalLinkOpenInSubmenu browsers={model.installedBrowsers} />
}

export function NativeChatFindMenuItem({ onSelect }: { onSelect: () => void }): React.JSX.Element {
  const keybindings = useAppStore((state) => state.keybindings)
  const shortcut = formatOptionalPrimaryShortcutLabel('chat.find', keybindings)
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <Search />
      {translate('components.native-chat.find.label', 'Find in chat')}
      {shortcut ? <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut> : null}
    </DropdownMenuItem>
  )
}

/** The hover rewind button's action, disabled with its reason when the button would be. */
function NativeChatRewindMenuItem({
  itemId,
  rewind
}: {
  itemId: string
  rewind: NativeChatRewindSurface
}): React.JSX.Element {
  const confirm = useConfirmationDialog()
  return (
    <DropdownMenuItem
      disabled={Boolean(rewind.disabledReason)}
      onSelect={() => void rewind.request(itemId, confirm)}
    >
      <Undo2 />
      <span className="grid min-w-0">
        {translate('components.native-chat.rewind.action', 'Rewind to here')}
        {/* A disabled row cannot show the button's tooltip, so its reason sits under the label. */}
        {rewind.disabledReason ? (
          <span className="text-xs whitespace-normal text-muted-foreground">
            {rewind.disabledReason}
          </span>
        ) : null}
      </span>
    </DropdownMenuItem>
  )
}

function LinkActionIcon({ action }: { action: LinkAction }): React.JSX.Element {
  if (action.external === true) {
    return <ExternalLink />
  }
  return action.external === false ? <Globe /> : <FileText />
}

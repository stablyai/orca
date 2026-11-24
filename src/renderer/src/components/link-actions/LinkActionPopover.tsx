import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, Globe, Settings } from 'lucide-react'
import { toast } from 'sonner'
import { ShortcutKeyCombo } from '@/components/ui/ShortcutKeyCombo'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useClipboardTextCopyFeedback } from '@/hooks/clipboard/use-clipboard-text-copy-feedback'
import { useTranslate } from '@/i18n/use-translate'
import { BROWSER_TERMINAL_LINK_ACTIONS_SETTINGS_TARGET_ID } from '@/components/settings/navigation/settings-navigation-types'
import { useAppStore } from '@/store/index'
import type { LinkAction, LinkActionRequest } from './link-action-request'
import { openLinkSettings } from '@/lib/links/preferences/link-preference-notice'
import { usesHttpLinkMode } from '@/lib/links/preferences/http-link-mode'

const MENU_ITEM_SELECTOR = '[data-link-popover-item]'

type LinkActionPopoverProps<TRequest extends LinkActionRequest> = {
  request: TRequest | null
  onClose: (dismissed?: TRequest) => void
  onPointerDownOutside?: (event: Event) => void
  onOpenSettings?: (() => void) | null
}

function ActionRow({
  action,
  shortcut,
  inMenu,
  onRun
}: {
  action: LinkAction
  shortcut: 'primary' | 'alternate' | null
  /** Only a keyboard-hosted chooser is a menu; other choosers keep plain button semantics. */
  inMenu: boolean
  onRun: () => void
}): React.JSX.Element {
  const isMac = navigator.userAgent.includes('Mac')
  const keys =
    shortcut === 'alternate'
      ? ['⇧', isMac ? '⌘' : 'Ctrl', 'Click']
      : shortcut === 'primary'
        ? [isMac ? '⌘' : 'Ctrl', 'Click']
        : null

  return (
    <Button
      {...(inMenu ? { role: 'menuitem' } : {})}
      data-link-popover-item
      className="h-8 w-full justify-start gap-1.5 px-1.5 text-[13px] font-normal has-[>svg]:px-1.5"
      variant="ghost"
      onClick={onRun}
    >
      {action.external === true ? <ExternalLink className="size-3.5" /> : null}
      {action.external === false ? <Globe className="size-3.5" /> : null}
      <span className="min-w-0 flex-1 truncate text-left" title={action.label}>
        {action.label}
      </span>
      {keys ? (
        <ShortcutKeyCombo keys={keys} keyCapClassName="min-w-5 px-1 py-0 text-[11px]" />
      ) : null}
    </Button>
  )
}

export function LinkActionPopover<TRequest extends LinkActionRequest>({
  request,
  onClose,
  onPointerDownOutside,
  onOpenSettings
}: LinkActionPopoverProps<TRequest>): React.JSX.Element {
  const t = useTranslate()
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const isFilePath = request?.kind === 'file'
  const canCopyDestination = isFilePath || request?.kind === 'url'
  const copyableDestination = canCopyDestination
    ? (request?.copyValue ?? request?.destination ?? '')
    : ''
  const { copyText, status: copyStatus } = useClipboardTextCopyFeedback(copyableDestination)
  const copyInFlightRef = useRef(false)
  const contentRef = useRef<HTMLDivElement>(null)
  // Keyed by request so every chooser starts unticked without resetting in an effect.
  const [rememberFor, setRememberFor] = useState<TRequest | null>(null)
  const remember = request?.rememberEligible === true && rememberFor === request
  const keyboardHost = request?.linkPreferenceHost === true && request.kind === 'url'
  // Every desktop web link follows the app-wide Links setting, so its footer goes there, not to terminal clicks.
  const linkSettingsTarget = request?.kind === 'url' && usesHttpLinkMode()
  const dismissOnOutsidePointerDown = useEffectEvent((event: PointerEvent): void => {
    if (!request || (event.target instanceof Node && contentRef.current?.contains(event.target))) {
      return
    }
    onPointerDownOutside?.(event)
    onClose(request)
  })
  useEffect(() => {
    if (!request) {
      return
    }
    // Why: Radix defers outside dismissal to the click and skips it when the click's
    // propagation is stopped, which hover cards and sidebar cards both do.
    document.addEventListener('pointerdown', dismissOnOutsidePointerDown, true)
    return () => document.removeEventListener('pointerdown', dismissOnOutsidePointerDown, true)
  }, [request])
  const virtualRef = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => new DOMRect(request?.anchorX ?? 0, request?.anchorY ?? 0, 0, 0)
      }
    }),
    [request?.anchorX, request?.anchorY]
  )

  useEffect(() => {
    if (!keyboardHost) {
      return
    }
    // Opt-in keyboard model: focus lands on the first destination row once the content mounts.
    const frame = requestAnimationFrame(() =>
      contentRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    )
    return () => cancelAnimationFrame(frame)
  }, [keyboardHost, request])

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!keyboardHost || !request) {
      return
    }
    if (event.key === 'Tab') {
      // Close and hand focus back; the browser then moves Tab on from the restored element.
      onClose(request)
      request.restoreFocus()
      return
    }
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR))
    if (items.length === 0) {
      return
    }
    const active = document.activeElement
    const current = active instanceof HTMLElement ? items.indexOf(active) : -1
    const next =
      event.key === 'ArrowDown'
        ? (current + 1) % items.length
        : event.key === 'ArrowUp'
          ? (current - 1 + items.length) % items.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : null
    if (next === null) {
      return
    }
    event.preventDefault()
    items[next]?.focus()
  }

  const runAction = (action: LinkAction): void => {
    onClose()
    request?.restoreFocus()
    // Only the two browser rows save; Copy and "Open in new tab" never do.
    void action.run(action.rememberAs ? { remember } : undefined)
  }

  const settingsLabel = linkSettingsTarget
    ? t('components.link.actions.linkSettings', 'Link settings')
    : t(
        'auto.components.terminal.pane.TerminalLinkActionPopover.terminalLinkSettings',
        'Terminal link settings'
      )
  const copyLabel =
    copyStatus === 'copied'
      ? t('auto.components.terminal.pane.TerminalLinkActionPopover.copied', 'Copied')
      : isFilePath
        ? t(
            'auto.components.terminal.pane.TerminalLinkActionPopover.copyFilePath',
            'Copy file path'
          )
        : t('auto.components.terminal.pane.TerminalLinkActionPopover.copyLink', 'Copy link')

  const copiedMessage = isFilePath
    ? t(
        'auto.components.terminal.pane.TerminalLinkActionPopover.copiedFilePath',
        'Copied file path'
      )
    : t('auto.components.terminal.pane.TerminalLinkActionPopover.copiedLink', 'Copied link')
  const copyFailedMessage = isFilePath
    ? t(
        'auto.components.terminal.pane.TerminalLinkActionPopover.copyFilePathFailed',
        'Failed to copy file path'
      )
    : t(
        'auto.components.terminal.pane.TerminalLinkActionPopover.copyLinkFailed',
        'Failed to copy link'
      )

  const copyDestination = async (): Promise<void> => {
    if (copyInFlightRef.current) {
      return
    }
    copyInFlightRef.current = true
    try {
      if (await copyText()) {
        toast.success(copiedMessage)
        return
      }
      toast.error(copyFailedMessage)
    } finally {
      copyInFlightRef.current = false
    }
  }

  const openFooterSettings = (): void => {
    onClose()
    onOpenSettings?.()
    if (linkSettingsTarget) {
      openLinkSettings()
      return
    }
    openSettingsTarget({
      pane: 'browser',
      repoId: null,
      sectionId: BROWSER_TERMINAL_LINK_ACTIONS_SETTINGS_TARGET_ID
    })
    openSettingsPage()
  }

  return (
    <Popover
      open={request !== null}
      onOpenChange={(open) => !open && onClose(request ?? undefined)}
    >
      <PopoverAnchor virtualRef={virtualRef} />
      {request ? (
        <PopoverContent
          ref={contentRef}
          align="start"
          side="top"
          sideOffset={6}
          collisionPadding={8}
          className="w-max min-w-52 max-w-[min(21rem,calc(100vw-1rem))] p-1"
          data-link-action-popover
          data-terminal-link-action-popover
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={() => request.restoreFocus()}
          {...(keyboardHost ? { role: 'menu', onKeyDown: onMenuKeyDown } : {})}
        >
          <div className="mb-0.5 flex items-center gap-1 overflow-hidden border-b border-border px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
            <span
              className="line-clamp-2 min-w-0 flex-1 break-all"
              data-terminal-link-destination
              title={request.destination}
            >
              {request.destination}
            </span>
            {canCopyDestination ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    data-link-popover-item
                    aria-label={copyLabel}
                    className="text-muted-foreground"
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => void copyDestination()}
                  >
                    {copyStatus === 'copied' ? <Check /> : <Copy />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {copyLabel}
                </TooltipContent>
              </Tooltip>
            ) : null}
            {onOpenSettings !== null ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    data-link-popover-item
                    aria-label={settingsLabel}
                    className="text-muted-foreground"
                    size="icon-xs"
                    variant="ghost"
                    onClick={openFooterSettings}
                  >
                    <Settings />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {settingsLabel}
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
          <ActionRow
            action={request.primary}
            shortcut="primary"
            inMenu={keyboardHost}
            onRun={() => runAction(request.primary)}
          />
          {request.alternate ? (
            <ActionRow
              action={request.alternate}
              shortcut="alternate"
              inMenu={keyboardHost}
              onRun={() => runAction(request.alternate!)}
            />
          ) : null}
          {request.secondaryActions?.map((action) => (
            <ActionRow
              key={action.label}
              action={action}
              shortcut={null}
              inMenu={keyboardHost}
              onRun={() => runAction(action)}
            />
          ))}
          {request.rememberEligible ? (
            // The divider lives on a wrapper: Button owns its own border and shape.
            <div className="mt-0.5 border-t border-border">
              <Button
                role="menuitemcheckbox"
                aria-checked={remember}
                data-link-popover-item
                className="w-full justify-start"
                variant="ghost"
                size="menu"
                // Toggling keeps the chooser open; the browser row chosen next reads it.
                onClick={() => setRememberFor(remember ? null : request)}
              >
                <span
                  aria-hidden
                  className="grid size-3.5 place-items-center rounded-[3px] border border-muted-foreground/60 aria-checked:border-primary aria-checked:bg-primary aria-checked:text-primary-foreground"
                  aria-checked={remember}
                >
                  {remember ? <Check className="size-3" /> : null}
                </span>
                <span className="font-normal text-muted-foreground">
                  {t('components.link.actions.rememberChoice', 'Always open links this way')}
                </span>
              </Button>
            </div>
          ) : null}
        </PopoverContent>
      ) : null}
    </Popover>
  )
}

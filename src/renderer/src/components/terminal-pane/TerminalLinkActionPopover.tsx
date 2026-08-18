import { useMemo, useRef } from 'react'
import { Check, Copy, ExternalLink, Globe, Settings } from 'lucide-react'
import { toast } from 'sonner'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useClipboardTextCopyFeedback } from '@/hooks/use-clipboard-text-copy-feedback'
import { translate } from '@/i18n/i18n'
import { BROWSER_TERMINAL_LINK_ACTIONS_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'
import { useAppStore } from '@/store'
import type { TerminalLinkAction, TerminalLinkActionRequest } from './terminal-link-action-request'

type TerminalLinkActionPopoverProps = {
  request: TerminalLinkActionRequest | null
  onClose: (dismissed?: TerminalLinkActionRequest) => void
}

function ActionRow({
  action,
  alternate,
  onRun
}: {
  action: TerminalLinkAction
  alternate: boolean
  onRun: () => void
}): React.JSX.Element {
  const isMac = navigator.userAgent.includes('Mac')
  const keys = alternate
    ? [isMac ? '⇧' : 'Shift', isMac ? '⌘' : 'Ctrl', 'Click']
    : [isMac ? '⌘' : 'Ctrl', 'Click']

  return (
    <Button
      className="h-8 w-full justify-start gap-1.5 px-1.5 text-[13px] font-normal has-[>svg]:px-1.5"
      variant="ghost"
      onClick={onRun}
    >
      {action.external === true ? <ExternalLink className="size-3.5" /> : null}
      {action.external === false ? <Globe className="size-3.5" /> : null}
      <span className="min-w-0 flex-1 text-left">{action.label}</span>
      <ShortcutKeyCombo keys={keys} keyCapClassName="min-w-5 px-1 py-0 text-[11px]" />
    </Button>
  )
}

export function TerminalLinkActionPopover({
  request,
  onClose
}: TerminalLinkActionPopoverProps): React.JSX.Element {
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const copyableDestination = request?.kind === 'url' ? request.destination : ''
  const { copyText, status: copyStatus } = useClipboardTextCopyFeedback(copyableDestination)
  const copyInFlightRef = useRef(false)
  const virtualRef = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => new DOMRect(request?.anchorX ?? 0, request?.anchorY ?? 0, 0, 0)
      }
    }),
    [request?.anchorX, request?.anchorY]
  )

  const runAction = (action: TerminalLinkAction): void => {
    onClose()
    request?.focusTerminal()
    void action.run()
  }

  const settingsLabel = translate(
    'auto.components.terminal.pane.TerminalLinkActionPopover.terminalLinkSettings',
    'Terminal link settings'
  )
  const copyLabel =
    copyStatus === 'copied'
      ? translate('auto.components.terminal.pane.TerminalLinkActionPopover.copied', 'Copied')
      : translate('auto.components.terminal.pane.TerminalLinkActionPopover.copyLink', 'Copy link')

  const copyDestination = async (): Promise<void> => {
    if (copyInFlightRef.current) {
      return
    }
    copyInFlightRef.current = true
    try {
      if (await copyText()) {
        toast.success(
          translate(
            'auto.components.terminal.pane.TerminalLinkActionPopover.copiedLink',
            'Copied link'
          )
        )
        return
      }
      toast.error(
        translate(
          'auto.components.terminal.pane.TerminalLinkActionPopover.copyLinkFailed',
          'Failed to copy link'
        )
      )
    } finally {
      copyInFlightRef.current = false
    }
  }

  const openTerminalLinkSettings = (): void => {
    onClose()
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
          align="start"
          side="top"
          sideOffset={6}
          collisionPadding={8}
          className="w-max min-w-52 max-w-[min(17rem,calc(100vw-1rem))] p-1"
          data-terminal-link-action-popover
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={() => request.focusTerminal()}
        >
          <div className="mb-0.5 flex items-center gap-1 overflow-hidden border-b border-border px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
            <span
              className="line-clamp-2 min-w-0 flex-1 break-all"
              data-terminal-link-destination
              title={request.destination}
            >
              {request.destination}
            </span>
            {request.kind === 'url' ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
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
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={settingsLabel}
                  className="text-muted-foreground"
                  size="icon-xs"
                  variant="ghost"
                  onClick={openTerminalLinkSettings}
                >
                  <Settings />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {settingsLabel}
              </TooltipContent>
            </Tooltip>
          </div>
          <ActionRow
            action={request.primary}
            alternate={false}
            onRun={() => runAction(request.primary)}
          />
          {request.alternate ? (
            <ActionRow
              action={request.alternate}
              alternate
              onRun={() => runAction(request.alternate!)}
            />
          ) : null}
        </PopoverContent>
      ) : null}
    </Popover>
  )
}

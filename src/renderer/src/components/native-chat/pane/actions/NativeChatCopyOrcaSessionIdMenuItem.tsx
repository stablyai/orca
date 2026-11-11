import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

export type CopyOrcaIdMenuItemCopy = {
  label: string
  tooltip: string
  copied: string
  failed: string
}

/** Copies an Orca id the host resolves at click, `orca_session_id:<id>`; null resolves as a failure. */
export function CopyOrcaIdMenuItem({
  resolveOrcaSessionId,
  copy,
  onSettled
}: {
  resolveOrcaSessionId: () => Promise<string | null>
  copy: CopyOrcaIdMenuItemCopy
  onSettled?: () => void
}): React.JSX.Element {
  const copyOrcaSessionId = async (): Promise<void> => {
    try {
      const orcaSessionId = await resolveOrcaSessionId()
      if (!orcaSessionId) {
        throw new Error('no Orca session ID')
      }
      await window.api.ui.writeClipboardText(orcaSessionId)
      toast.success(copy.copied)
    } catch {
      toast.error(copy.failed)
    } finally {
      onSettled?.()
    }
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuItem onSelect={() => void copyOrcaSessionId()}>
          <Copy />
          {copy.label}
        </DropdownMenuItem>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="max-w-[220px]">
        {copy.tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

/** Copies the chat's Orca session ID from the host: `orca_session_id:<root>`, which `/clear` keeps. */
export function NativeChatCopyOrcaSessionIdMenuItem({
  resolveOrcaSessionId
}: {
  resolveOrcaSessionId: () => Promise<string | null>
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <CopyOrcaIdMenuItem
      resolveOrcaSessionId={resolveOrcaSessionId}
      copy={{
        label: t('components.native-chat.contextMenu.copyOrcaSessionId', 'Copy Orca Session ID'),
        tooltip: t(
          'components.native-chat.contextMenu.orcaSessionIdTooltip',
          "Orca's ID for this chat, separate from the agent CLI's own session ID. Agents use it to refer to each other through Orca."
        ),
        copied: t(
          'components.native-chat.contextMenu.orcaSessionIdCopied',
          'Orca session ID copied'
        ),
        failed: t(
          'components.native-chat.contextMenu.orcaSessionIdCopyFailed',
          'Unable to copy Orca session ID'
        )
      }}
    />
  )
}

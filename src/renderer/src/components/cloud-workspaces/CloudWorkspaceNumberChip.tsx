// W-123 in the top bar when the workspace in front is a cloud workspace; click copies its link
// (the same as ⌘⌥⇧L) and confirms in place. Renders nothing for local workspaces or before the
// number is known.
import React, { useEffect, useState } from 'react'
import { Check, Link2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatOptionalPrimaryShortcutLabel } from '@/hooks/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { formatWorkspaceNumber } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { sandboxIdForWorktree, useCloudWorkspaceIdentities } from './cloud-workspace-identity'
import { copyCloudWorkspaceLink } from './open-cloud-workspace'

const COPIED_MS = 1_500

export function CloudWorkspaceNumberChip({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const hostId = useAppStore((s) => s.activeWorkspaceExecutionHostId)
  const keybindings = useAppStore((s) => s.keybindings)
  const identities = useCloudWorkspaceIdentities()
  const [copied, setCopied] = useState(false)
  // Hover/focus opens the tooltip; a copy holds it open to confirm, so the chip never changes width.
  const [tipOpen, setTipOpen] = useState(false)
  useEffect(() => {
    if (!copied) {
      return
    }
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])
  const sandboxId = sandboxIdForWorktree({ id: worktreeId, hostId }, identities)
  const number = sandboxId ? (identities.bySandbox.get(sandboxId)?.number ?? null) : null
  if (!sandboxId || !number) {
    return null
  }
  const label = formatWorkspaceNumber(number)
  const shortcut = formatOptionalPrimaryShortcutLabel('cloudWorkspace.copyLink', keybindings)
  const copiedLabel = t('auto.components.cloudWorkspaces.linkCopiedShort', 'Link copied')
  return (
    <>
      <Tooltip open={tipOpen || copied} onOpenChange={setTipOpen}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => {
              // The workspace only: a teammate opening it shouldn't land on your terminal or chat.
              void copyCloudWorkspaceLink(sandboxId, null, { quiet: true }).then(
                (ok) => ok && setCopied(true)
              )
            }}
            aria-label={t('auto.components.cloudWorkspaces.copyLinkTo', 'Copy link to {{number}}', {
              number: label
            })}
            className={cn(
              'mr-2 flex h-6 items-center gap-1 rounded-md px-1.5 font-mono max-[960px]:hidden text-2xs tabular-nums text-muted-foreground outline-none [-webkit-app-region:no-drag] hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus-ring',
              copied && 'text-foreground'
            )}
          >
            {/* The link glyph says what the chip does before anyone hovers it (N-05). */}
            {copied ? (
              <Check className="size-3 shrink-0" aria-hidden />
            ) : (
              <Link2 className="size-3 shrink-0" aria-hidden />
            )}
            {label}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {copied ? (
            copiedLabel
          ) : (
            <>
              {t('auto.components.cloudWorkspaces.copyLinkTo', 'Copy link to {{number}}', {
                number: label
              })}
              {shortcut ? <span className="ml-1.5 text-muted-foreground">{shortcut}</span> : null}
            </>
          )}
        </TooltipContent>
      </Tooltip>
      <span aria-live="polite" className="sr-only">
        {copied ? copiedLabel : ''}
      </span>
    </>
  )
}

import { useState } from 'react'
import { ChevronRight, Clipboard, Link2Off, Loader2, MoreHorizontal, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { SkillCloudOwnedShare } from '../../../../shared/skill-cloud-contract'
import { skillCountLabel } from './skill-display-labels'
import { isSkillBundleVersion } from './skill-share-version-summary'

const createdFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric'
})

function createdLabel(createdAt: string): string {
  const parsed = new Date(createdAt)
  return Number.isNaN(parsed.getTime())
    ? translate('auto.components.skills.SkillRow.updatedUnknown', 'No date')
    : createdFormatter.format(parsed)
}

/** The shares endpoint carries no membership, so the skill list is fetched from
 *  the package only when a row is opened — 50 links must not mean 50 requests. */
function useShareContents(share: SkillCloudOwnedShare): {
  names: string[] | null
  failed: boolean
  load: () => void
} {
  const [names, setNames] = useState<string[] | null>(null)
  const [failed, setFailed] = useState(false)

  const load = (): void => {
    if (names || failed) {
      return
    }
    void (async () => {
      try {
        const operation = await window.api.skills.getPackage(share.packageId)
        if (operation.status !== 'ok') {
          setFailed(true)
          return
        }
        const version = operation.value.versions.at(0)
        setNames(
          version && isSkillBundleVersion(version)
            ? version.manifest.skills.map((entry) => entry.name)
            : [share.name]
        )
      } catch {
        setFailed(true)
      }
    })()
  }

  return { names, failed, load }
}

export function SkillSharedLinkRow({
  share,
  busy,
  onRevoke,
  onDeleted
}: {
  share: SkillCloudOwnedShare
  busy: boolean
  onRevoke: () => void
  onDeleted: () => void
}): React.JSX.Element {
  const [confirming, setConfirming] = useState<'revoke' | 'delete' | null>(null)
  const [deleting, setDeleting] = useState(false)
  const { names, failed, load } = useShareContents(share)

  const deletePackage = async (): Promise<void> => {
    setDeleting(true)
    try {
      const operation = await window.api.skills.deletePackage(share.packageId)
      if (operation.status !== 'ok') {
        toast.error(
          translate(
            'auto.components.skills.SkillSharedLinkRow.deleteFailed',
            'Orca could not delete this from the Cloud.'
          )
        )
        return
      }
      toast.success(
        translate('auto.components.skills.SkillSharedLinkRow.deleted', 'Deleted from the Cloud')
      )
      onDeleted()
    } finally {
      setDeleting(false)
    }
  }

  const copy = async (): Promise<void> => {
    await window.api.ui.writeClipboardText(share.url)
    toast.success(translate('auto.components.settings.shareSkills.linkCopied', 'Share link copied'))
  }

  return (
    <li>
      <Collapsible className="group/link" onOpenChange={(open) => open && load()}>
        <div className="flex items-center gap-3 px-3 py-2">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{share.name}</span>
              <span className="block truncate font-mono text-[11px] text-muted-foreground">
                {share.url}
              </span>
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {createdLabel(share.createdAt)}
            </span>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/link:rotate-90" />
          </CollapsibleTrigger>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="shrink-0"
                onClick={() => void copy()}
                aria-label={translate('auto.components.settings.shareSkills.copyLink', 'Copy link')}
              >
                <Clipboard />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {translate('auto.components.settings.shareSkills.copyLink', 'Copy link')}
            </TooltipContent>
          </Tooltip>
          {confirming ? (
            <Button
              type="button"
              size="xs"
              variant="destructive"
              className="shrink-0"
              // Why: the icon button unmounts when it swaps to this one, so
              // keyboard focus has to be handed over explicitly.
              autoFocus
              disabled={busy || deleting}
              onClick={() => (confirming === 'revoke' ? onRevoke() : void deletePackage())}
            >
              {busy || deleting ? <Loader2 className="animate-spin" /> : null}
              {confirming === 'revoke'
                ? translate(
                    'auto.components.settings.shareSkills.confirmUnshare',
                    'Confirm unshare'
                  )
                : translate(
                    'auto.components.skills.SkillSharedLinkRow.confirmDelete',
                    'Confirm delete'
                  )}
            </Button>
          ) : (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    disabled={busy}
                    onClick={() => setConfirming('revoke')}
                    aria-label={translate(
                      'auto.components.settings.shareSkills.unshare',
                      'Unshare'
                    )}
                  >
                    <Link2Off />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {translate('auto.components.settings.shareSkills.unshare', 'Unshare')}
                </TooltipContent>
              </Tooltip>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="shrink-0"
                    disabled={busy}
                    aria-label={translate(
                      'auto.components.skills.SkillSharedLinkRow.moreActions',
                      'More actions for {{name}}',
                      { name: share.name }
                    )}
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {/* Why: unsharing only closes the link; this removes the
                      published copy itself, so it stays one level down. */}
                  <DropdownMenuItem variant="destructive" onSelect={() => setConfirming('delete')}>
                    <Trash2 />
                    {translate(
                      'auto.components.skills.SkillSharedLinkRow.deletePackage',
                      'Delete from the Cloud'
                    )}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>
        <CollapsibleContent className="collapsible-height-content px-3 pb-3">
          {failed ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.skills.SkillSharedLinkRow.contentsUnavailable',
                'Could not load what this link contains.'
              )}
            </p>
          ) : names ? (
            <div className="rounded-md border border-border p-2">
              <p className="pb-1 text-[11px] text-muted-foreground">
                {skillCountLabel(names.length)}
              </p>
              <ul className="scrollbar-sleek max-h-48 space-y-0.5 overflow-y-auto">
                {names.map((name) => (
                  <li key={name} className="truncate text-xs">
                    {name}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {translate('auto.components.skills.SkillSharedLinkRow.loading', 'Loading contents…')}
            </p>
          )}
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

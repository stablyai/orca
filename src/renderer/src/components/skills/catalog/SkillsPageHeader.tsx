import { Download, History, Link2, Share2, Trash2 } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  RailPageHeader,
  RailPageMoreMenu,
  RailPagePrimaryButton,
  RailPageRefreshButton,
  RailPageSecondaryButton
} from '@/components/rail-page/RailPageHeader'
import { useTranslate } from '@/i18n/use-translate'
import { SkillsSourcesPopover } from './SkillsSourcesPopover'
import type { SkillSourceInventoryEntry } from './skill-source-inventory'

export function SkillsPageHeader({
  skillCount,
  sourceEntries,
  scannedSourceCount,
  hostLabel,
  onClose,
  refreshing,
  onRefresh,
  onStartShare,
  deleteSupported,
  deleteUnsupportedReason,
  onStartDelete,
  onInstallFromLink,
  onManageInstalls,
  onOpenSharedLinks
}: {
  skillCount: number | null
  refreshing: boolean
  onRefresh: () => void
  sourceEntries: readonly SkillSourceInventoryEntry[]
  scannedSourceCount: number
  hostLabel: string | null
  onClose: () => void
  onStartShare: () => void
  /** Disable deletion with a reason until the target and host capability are known. */
  deleteSupported: boolean
  deleteUnsupportedReason: string | null
  onStartDelete: () => void
  onInstallFromLink: () => void
  onManageInstalls: () => void
  onOpenSharedLinks: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const installLabel = t('auto.components.skills.SkillsPage.aee7b99cc6', 'Install from link')
  const shareLabel = t(
    'auto.components.skills.SkillShareSelectionControls.01c5a15e02',
    'Share skills'
  )
  return (
    <RailPageHeader
      title={t('auto.components.skills.SkillsPage.f43ad6edf3', 'Skills')}
      count={skillCount}
      close={{
        label: t('auto.components.skills.SkillsPage.closeSkills', 'Close skills'),
        tooltip: t('auto.components.skills.SkillsPage.closeTooltip', 'Close · Esc'),
        onClose
      }}
      scope={
        <>
          {sourceEntries.length > 0 ? (
            <SkillsSourcesPopover entries={sourceEntries} scannedCount={scannedSourceCount} />
          ) : null}
          {hostLabel ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground" title={hostLabel}>
              {hostLabel}
            </span>
          ) : null}
        </>
      }
      actions={
        <>
          <RailPageRefreshButton
            label={t('auto.components.skills.SkillsPage.cb142070b4', 'Refresh')}
            busy={refreshing}
            onRefresh={onRefresh}
          />
          <RailPageSecondaryButton
            icon={<Share2 className="size-3.5" />}
            label={shareLabel}
            aria-label={shareLabel}
            onClick={onStartShare}
          />
          <RailPageMoreMenu>
            <DropdownMenuItem onSelect={onManageInstalls}>
              <History />
              {t('auto.components.skills.SkillsPage.c13b82793c', 'Manage installs')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onOpenSharedLinks}>
              <Link2 />
              {t('auto.components.skills.SkillsPage.sharedLinks', 'Shared links')}
            </DropdownMenuItem>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="pointer-events-auto block">
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={!deleteSupported}
                    onSelect={onStartDelete}
                  >
                    <Trash2 />
                    {t('auto.components.skills.SkillsPage.deleteSkills', 'Delete skills…')}
                  </DropdownMenuItem>
                </span>
              </TooltipTrigger>
              {deleteSupported || !deleteUnsupportedReason ? null : (
                <TooltipContent side="left" sideOffset={4}>
                  {deleteUnsupportedReason}
                </TooltipContent>
              )}
            </Tooltip>
          </RailPageMoreMenu>
          <RailPagePrimaryButton
            icon={<Download className="size-3.5" />}
            label={installLabel}
            aria-label={installLabel}
            onClick={onInstallFromLink}
          />
        </>
      }
    />
  )
}

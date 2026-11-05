import { ChevronRight, Loader2, MonitorUp, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { SkillBundleInstallResult } from '../../../../shared/skill-bundle-install-contract'
import type { SkillInstallResult } from '../../../../shared/skill-install-contract'
import type { SkillCloudPackageDetails } from '../../../../shared/skill-cloud-contract'
import type { SkillManagedInstallGroup } from './skill-managed-install-groups'
import {
  managedInstalledOnLabel,
  managedInstallScopeLabel,
  managedInstallStateNote,
  managedInstallTitle,
  managedSkillStateNote,
  managedVersionLabel
} from './skill-managed-install-labels'

function SkillLines({ group }: { group: SkillManagedInstallGroup }): React.JSX.Element {
  return (
    <ul className="space-y-1">
      {group.installs.map((install) => {
        const note = managedSkillStateNote(install.state)
        return (
          <li key={install.name} className="flex items-baseline justify-between gap-3 text-xs">
            <span className="min-w-0 truncate">{install.name}</span>
            {note ? <span className="shrink-0 text-muted-foreground">{note}</span> : null}
          </li>
        )
      })}
    </ul>
  )
}

export function SkillManagedInstallRow({
  group,
  open,
  details,
  versionId,
  busy,
  confirmRemove,
  installActive,
  editedWarning,
  bundleResult,
  result,
  onOpenChange,
  onVersionChange,
  onInstall,
  onCancelInstall,
  onSendToMachine,
  onRemove
}: {
  group: SkillManagedInstallGroup
  open: boolean
  details: SkillCloudPackageDetails | null
  versionId: string
  busy: boolean
  confirmRemove: boolean
  installActive: boolean
  editedWarning: boolean
  bundleResult: SkillBundleInstallResult | null
  result: SkillInstallResult | null
  onOpenChange: (open: boolean) => void
  onVersionChange: (versionId: string) => void
  onInstall: (discardLocal?: boolean) => void
  onCancelInstall: () => void
  onSendToMachine: (shareId: string) => void
  onRemove: (discardLocal?: boolean) => void
}): React.JSX.Element {
  const stateNote = managedInstallStateNote(group)
  const installedOn = managedInstalledOnLabel(group)
  const activeShare = details?.management?.shares[0]
  const switching = Boolean(versionId) && versionId !== group.versionId
  const retrying = result?.status === 'partial' || bundleResult?.status === 'partial'

  return (
    <li>
      <Collapsible open={open} onOpenChange={onOpenChange} className="group/install">
        <CollapsibleTrigger className="flex w-full items-center gap-3 px-3 py-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{managedInstallTitle(group)}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {group.installs.map((install) => install.name).join(', ')}
              {' · '}
              {managedInstallScopeLabel(group)}
            </span>
          </span>
          {stateNote ? (
            <span className="shrink-0 text-[11px] text-foreground">{stateNote}</span>
          ) : null}
          {installedOn ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">{installedOn}</span>
          ) : null}
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/install:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent className="collapsible-height-content space-y-3 px-3 pb-3">
          {group.installs.length > 1 ? <SkillLines group={group} /> : null}
          {details ? (
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">
                {translate('auto.components.skills.managedInstall.versionLabel', 'Version')}
              </span>
              <Select value={versionId} onValueChange={onVersionChange}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {details.versions.map((version) => (
                    <SelectItem key={version.versionId} value={version.versionId}>
                      {managedVersionLabel(version, group.versionId)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          ) : null}
          {editedWarning ? (
            <p className="text-xs text-muted-foreground" role="alert">
              {translate(
                'auto.components.skills.managedInstall.editedWarning',
                'Your edits are kept unless you choose to discard them.'
              )}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {details ? (
              <Button size="sm" disabled={busy} onClick={() => onInstall()}>
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="size-3.5" />
                )}
                {retrying
                  ? translate(
                      'auto.components.skills.managedInstall.finishInstall',
                      'Finish installing'
                    )
                  : switching
                    ? translate(
                        'auto.components.skills.managedInstall.useVersion',
                        'Use this version'
                      )
                    : translate('auto.components.skills.managedInstall.reinstall', 'Reinstall')}
              </Button>
            ) : null}
            {installActive ? (
              <Button variant="secondary" size="sm" onClick={onCancelInstall}>
                {translate('auto.components.skills.managedInstall.cancel', 'Cancel')}
              </Button>
            ) : null}
            {activeShare ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => onSendToMachine(activeShare.id)}
              >
                <MonitorUp className="size-3.5" />
                {translate(
                  'auto.components.skills.managedInstall.installElsewhere',
                  'Install elsewhere…'
                )}
              </Button>
            ) : null}
            <Button
              variant={confirmRemove ? 'destructive' : 'outline'}
              size="sm"
              className={cn(!confirmRemove && 'text-muted-foreground hover:text-destructive')}
              disabled={busy}
              onClick={() => onRemove()}
            >
              <Trash2 className="size-3.5" />
              {confirmRemove
                ? translate('auto.components.skills.managedInstall.confirmRemove', 'Confirm remove')
                : translate('auto.components.skills.managedInstall.remove', 'Remove')}
            </Button>
            {editedWarning ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onRemove(true)}>
                {translate(
                  'auto.components.skills.managedInstall.discardEditsRemove',
                  'Discard my edits and remove'
                )}
              </Button>
            ) : null}
            {editedWarning ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onInstall(true)}>
                {translate(
                  'auto.components.skills.managedInstall.discardEdits',
                  'Discard my edits and reinstall'
                )}
              </Button>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

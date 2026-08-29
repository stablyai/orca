import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type {
  ManagedSkillInstall,
  SkillInstallResult
} from '../../../../shared/skill-install-contract'
import type { SkillBundleInstallResult } from '../../../../shared/skill-bundle-install-contract'
import type { SkillCloudPackageDetails } from '../../../../shared/skill-cloud-contract'
import type { skillInstallManagementCopy } from './skill-install-management-copy'
import { skillInstallResultLabel } from './skill-install-result-label'
import { SkillInstallMachineSelect } from './SkillInstallMachineSelect'
import { SkillInstallManagementStatus } from './SkillInstallManagementStatus'
import { SkillManagedInstallRow } from './SkillManagedInstallRow'
import type { SkillManagedInstallGroup } from './skill-managed-install-groups'

type SkillInstallManagementDialogContentProps = {
  bundleResult: SkillBundleInstallResult | null
  busy: boolean
  confirmRemove: boolean
  copy: ReturnType<typeof skillInstallManagementCopy>
  details: SkillCloudPackageDetails | null
  environmentId: string
  error: string | null
  groups: SkillManagedInstallGroup[]
  installs: ManagedSkillInstall[]
  installActive: boolean
  notice: string | null
  result: SkillInstallResult | null
  progressLabel: string | null
  runtimeEnvironments: readonly { id: string; name: string }[]
  selectedKey: string
  sshConnectionStates: ReadonlyMap<string, { status: string }>
  sshTargetLabels: ReadonlyMap<string, string>
  versionId: string
  onCancelInstall: () => void
  onClose: () => void
  onEnvironmentChange: (value: string) => void
  onInstall: (discardLocal?: boolean) => void
  onOpenChange: (group: SkillManagedInstallGroup, open: boolean) => void
  onRemove: (discardLocal?: boolean) => void
  onSendToMachine: (shareId: string) => void
  onVersionChange: (versionId: string) => void
}

export function SkillInstallManagementDialogContent({
  bundleResult,
  busy,
  confirmRemove,
  copy,
  details,
  environmentId,
  error,
  groups,
  installs,
  installActive,
  notice,
  progressLabel,
  result,
  runtimeEnvironments,
  selectedKey,
  sshConnectionStates,
  sshTargetLabels,
  versionId,
  onCancelInstall,
  onClose,
  onEnvironmentChange,
  onInstall,
  onOpenChange,
  onRemove,
  onSendToMachine,
  onVersionChange
}: SkillInstallManagementDialogContentProps): React.JSX.Element {
  const destructiveConflict =
    result?.status === 'conflict' ||
    Boolean(
      groups
        .find((group) => group.key === selectedKey)
        ?.installs.some((install) => install.state === 'modified')
    )

  return (
    <DialogContent className="max-h-[calc(100vh-3rem)] overflow-x-hidden overflow-y-auto scrollbar-sleek sm:max-w-2xl [&>*]:min-w-0">
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.description}</DialogDescription>
      </DialogHeader>
      <SkillInstallMachineSelect
        value={environmentId}
        onChange={onEnvironmentChange}
        localLabel={copy.localMachine}
        sshLabel={copy.ssh}
        disconnectedLabel={copy.disconnected}
        environments={runtimeEnvironments}
        sshTargets={[...sshTargetLabels.entries()].map(([id, label]) => ({
          id: `ssh:${id}`,
          label,
          connected: sshConnectionStates.get(id)?.status === 'connected'
        }))}
      />
      {busy && installs.length === 0 ? <Loader2 className="mx-auto size-5 animate-spin" /> : null}
      {!busy && installs.length === 0 ? (
        <p className="rounded-md border border-border p-4 text-sm text-muted-foreground">
          {copy.noInstalls}
        </p>
      ) : null}
      {groups.length > 0 ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {groups.map((group) => (
            <SkillManagedInstallRow
              key={group.key}
              group={group}
              open={selectedKey === group.key}
              details={selectedKey === group.key ? details : null}
              versionId={selectedKey === group.key ? versionId : ''}
              busy={busy}
              confirmRemove={selectedKey === group.key && confirmRemove}
              installActive={installActive}
              editedWarning={selectedKey === group.key && destructiveConflict}
              bundleResult={selectedKey === group.key ? bundleResult : null}
              result={selectedKey === group.key ? result : null}
              onOpenChange={(next) => onOpenChange(group, next)}
              onVersionChange={onVersionChange}
              onInstall={onInstall}
              onCancelInstall={onCancelInstall}
              onSendToMachine={onSendToMachine}
              onRemove={onRemove}
            />
          ))}
        </ul>
      ) : null}
      <SkillInstallManagementStatus
        resultLabel={result ? skillInstallResultLabel(result) : null}
        progressLabel={progressLabel}
        error={error}
        notice={notice}
      />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          {copy.close}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

import type React from 'react'
import { useMemo } from 'react'
import { Monitor } from 'lucide-react'
import type { OrcaUninstallHostEntry } from '../../../../../../shared/uninstall/orca-uninstall-types'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../../ui/button'
import { useBoundedHostRows } from '../../../host-picker/use-bounded-host-rows'
import { HostListSearchField } from '../../../host-picker/HostListSearchField'
import { HostListOverflowNote } from '../../../host-picker/HostListOverflowNote'
import { isOrcaUninstallProblem } from './orca-uninstall-plan-state'
import { getOrcaUninstallSlotKind, OrcaUninstallCopyCommandButton } from './OrcaUninstallStatus'
import {
  ExpandableRow,
  PATH_CLASS,
  RowSlot,
  SUB_ROW_CLASS,
  SubRowSlot,
  useAutoExpand,
  type RowsModel
} from './OrcaUninstallRowLayout'
import { orcaUninstallRetryKey } from './use-orca-uninstall'

export function OrcaUninstallHostRows({ model }: { model: RowsModel }): React.JSX.Element | null {
  const t = useTranslate()
  const hosts = useMemo(() => model.plan?.hosts ?? [], [model.plan])
  const hostRows = useMemo(
    () => hosts.map((entry) => ({ id: entry.hostId, label: entry.label, entry })),
    [hosts]
  )
  // Problem hosts stay in view however many hosts are configured.
  const problemIds = useMemo(
    () =>
      new Set(
        hosts.filter((entry) => isOrcaUninstallProblem(entry.state)).map((entry) => entry.hostId)
      ),
    [hosts]
  )
  const rows = useBoundedHostRows(hostRows, problemIds)
  const [expanded, toggle] = useAutoExpand(problemIds.size > 0)
  if (hosts.length === 0) {
    return null
  }
  return (
    <>
      <ExpandableRow
        expanded={expanded}
        onToggle={toggle}
        label={t('settings.uninstall.rows.hosts', 'SSH hosts')}
        slot={
          <RowSlot
            model={model}
            step="ssh-hosts"
            meta={t('settings.uninstall.rows.hostCount', '{{count}} hosts', {
              count: hosts.length,
              defaultValue_one: '1 host'
            })}
          />
        }
      />
      {expanded ? (
        <div className="pl-6">
          {rows.searchable ? (
            <HostListSearchField value={rows.query} onChange={rows.setQuery} />
          ) : null}
          {rows.shown.map((row) => (
            <HostSubRow key={row.id} model={model} entry={row.entry} />
          ))}
          <HostListOverflowNote hiddenCount={rows.hiddenCount} />
        </div>
      ) : null}
    </>
  )
}

function HostSubRow({
  model,
  entry
}: {
  model: RowsModel
  entry: OrcaUninstallHostEntry
}): React.JSX.Element {
  const t = useTranslate()
  const running =
    (model.runningStep === 'ssh-hosts' && entry.state === 'present') ||
    model.retrying.has(orcaUninstallRetryKey('ssh-hosts', entry.hostId))
  const kind = getOrcaUninstallSlotKind([entry.state], running)
  let action: React.ReactNode = null
  if (model.phase === 'done' && entry.state === 'needs-user' && entry.manualCommand) {
    action = <OrcaUninstallCopyCommandButton command={entry.manualCommand} />
  } else if (model.phase === 'done' && entry.state === 'error') {
    action = (
      <Button
        variant="outline"
        size="xs"
        onClick={() => model.retry({ step: 'ssh-hosts', only: [entry.hostId] })}
      >
        {t('settings.uninstall.retry', 'Retry')}
      </Button>
    )
  }
  return (
    <div className={SUB_ROW_CLASS}>
      <Monitor className="size-3.5 text-muted-foreground" />
      <span className="min-w-0 break-words">{entry.label}</span>
      <span className={PATH_CLASS}>
        {entry.connected
          ? t('settings.uninstall.host.connected', 'Connected')
          : t('settings.uninstall.host.offline', 'Offline')}
      </span>
      <SubRowSlot
        kind={model.phase === 'idle' ? 'blank' : kind}
        detail={entry.detail}
        action={action}
      />
    </div>
  )
}

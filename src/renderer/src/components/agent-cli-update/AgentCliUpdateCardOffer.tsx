import { ChevronDown, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  copyAgentCliUpdateCommand,
  type AgentCliUpdateGroup,
  type AgentCliUpdateRow
} from '../status-bar/updates/AgentCliUpdateList'
import { agentCliProductName } from './agent-cli-product-name'
import {
  AgentCliUpdateCardManualRow,
  AgentCliUpdateCardReveal,
  AgentCliUpdateCardRow,
  AgentCliUpdateCardVersions,
  AgentCliUpdateIconStack
} from './AgentCliUpdateCardRows'

function joinNames(names: readonly string[], t: Translate): string {
  const [first = '', second = '', third = ''] = names
  if (names.length <= 1) {
    return first
  }
  if (names.length === 2) {
    return t('agentCliUpdate.cardNamesTwo', '{{first}} and {{second}}', { first, second })
  }
  if (names.length === 3) {
    return t('agentCliUpdate.cardNamesThree', '{{first}}, {{second}} and {{third}}', {
      first,
      second,
      third
    })
  }
  // Past four, one name keeps the line from truncating beside the icon stack.
  return names.length === 4
    ? t('agentCliUpdate.cardNamesSome', '{{first}}, {{second}} and {{count}} more', {
        first,
        second,
        count: 2,
        defaultValue_one: '{{first}}, {{second}} and {{count}} more'
      })
    : t('agentCliUpdate.cardNamesMany', '{{first}} and {{count}} more', {
        first,
        count: names.length - 1,
        defaultValue_one: '{{first}} and {{count}} more'
      })
}
/** The offer: what changed, versions under Details, Later and Update all. */
export function AgentCliUpdateCardOffer({
  groups,
  offerRows,
  startable,
  detailsOpen,
  onToggleDetails,
  onUpdate,
  onClose
}: {
  groups: readonly AgentCliUpdateGroup[]
  offerRows: readonly AgentCliUpdateRow[]
  startable: readonly AgentCliUpdateRow[]
  detailsOpen: boolean
  onToggleDetails: () => void
  onUpdate: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const single = offerRows.length === 1 ? offerRows[0] : null
  const hosts = groups.filter((group) => group.rows.some((row) => row.update))
  const multiHost = hosts.length > 1
  const title = single?.update
    ? t('agentCliUpdate.cardSingleTitle', '{{name}} {{version}} is out', {
        name: agentCliProductName(single.agent, t, 'short'),
        version: single.update.latestVersion
      })
    : multiHost
      ? t('agentCliUpdate.cardHostsTitle', '{{count}} CLI updates on {{hosts}} hosts', {
          count: offerRows.length,
          hosts: hosts.length,
          defaultValue_one: '{{count}} CLI update on {{hosts}} hosts'
        })
      : t('agentCliUpdate.statusCount', '{{count}} CLI updates', {
          count: offerRows.length,
          defaultValue_one: '{{count}} CLI update'
        })
  const subtitle = single?.update
    ? t('agentCliUpdate.cardSingleInstalled', 'You have {{version}}', {
        version: single.update.installedVersion
      })
    : multiHost
      ? joinNames(
          hosts.map((group) => group.label ?? ''),
          t
        )
      : joinNames(
          offerRows.map((row) => agentCliProductName(row.agent, t, 'short')),
          t
        )
  const manualCount = offerRows.filter((row) => row.update && !row.update.runnable).length
  const singleManual = single?.update && !single.update.runnable ? single.update.command : null
  const primary = singleManual
    ? t('agentCliUpdate.copyCommandFull', 'Copy command')
    : single
      ? t('agentCliUpdate.update', 'Update')
      : manualCount > 0
        ? t('agentCliUpdate.cardUpdateSome', 'Update {{count}} CLIs', {
            count: startable.length,
            defaultValue_one: 'Update {{count}} CLI'
          })
        : t('agentCliUpdate.updateAll', 'Update all')

  return (
    <>
      <div className="flex items-start gap-3 pt-3.5 pr-2.5 pl-3.5">
        <AgentCliUpdateIconStack agents={offerRows.map((row) => row.agent)} />
        <div className="min-w-0 flex-1 pt-px">
          <p className="text-sm font-semibold">{title}</p>
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={onClose}
          aria-label={t('agentCliUpdate.cardDismiss', 'Dismiss')}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {single ? null : (
        <AgentCliUpdateCardReveal open={detailsOpen}>
          <div className="mx-2 mt-3 border-t border-border pt-1.5">
            {groups.map((group) => {
              const offered = group.rows.filter((row) => row.update)
              return offered.length === 0 ? null : (
                <div key={group.hostKey}>
                  {group.label ? (
                    <div className="px-2 pt-1.5 pb-1 text-2xs text-muted-foreground">
                      {group.label}
                    </div>
                  ) : null}
                  {offered.map((row) =>
                    row.update && !row.update.runnable ? (
                      <AgentCliUpdateCardManualRow
                        key={row.agent}
                        agent={row.agent}
                        from={row.update.installedVersion}
                        to={row.update.latestVersion}
                        command={row.update.command}
                      />
                    ) : (
                      <AgentCliUpdateCardRow key={row.agent} agent={row.agent}>
                        {row.update ? (
                          <AgentCliUpdateCardVersions
                            from={row.update.installedVersion}
                            to={row.update.latestVersion}
                          />
                        ) : null}
                      </AgentCliUpdateCardRow>
                    )
                  )}
                </div>
              )
            })}
          </div>
        </AgentCliUpdateCardReveal>
      )}
      <div className="flex items-center gap-1.5 px-3.5 pt-3 pb-3.5">
        {single ? null : (
          <Button
            type="button"
            variant="disclosure"
            size="xs"
            className="-ml-2"
            aria-expanded={detailsOpen}
            onClick={onToggleDetails}
          >
            {t('agentCliUpdate.cardDetails', 'Details')}
            <ChevronDown
              className={cn(
                'size-3 transition-transform duration-200 ease-out motion-reduce:transition-none',
                detailsOpen && 'rotate-180'
              )}
            />
          </Button>
        )}
        <span className="flex-1" />
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {t('agentCliUpdate.cardLater', 'Later')}
        </Button>
        {singleManual ? (
          <Button
            type="button"
            size="sm"
            onClick={() => {
              copyAgentCliUpdateCommand(singleManual, t)
              onClose()
            }}
          >
            {primary}
          </Button>
        ) : startable.length > 0 || manualCount === 0 ? (
          <Button type="button" size="sm" disabled={startable.length === 0} onClick={onUpdate}>
            {primary}
          </Button>
        ) : null}
      </div>
    </>
  )
}

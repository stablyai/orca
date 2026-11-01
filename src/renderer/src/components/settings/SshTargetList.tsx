import type { SshConnectionState, SshTarget } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import { Checkbox } from '../ui/checkbox'
import { VirtualizedList } from '../virtualized-list'
import { useSettingsContentScrollElement } from './settings-content-scroll-element'
import type { SshTargetBusyAction } from './ssh-target-action-state'
import {
  groupSshTargetsBySource,
  sshTargetGroupCheckState,
  type SshTargetGroup,
  type SshTargetGroupId
} from './ssh-target-list-model'
import { SshTargetCard } from './SshTargetCard'
import type { SshTargetSelection } from './use-ssh-target-selection'

type SshTargetListProps = {
  targets: readonly SshTarget[]
  /** Unfiltered group sizes, so a filtered group reads "2 of 17" rather than shrinking silently. */
  totalBySource: Record<SshTargetGroupId, number>
  connectionStates: ReadonlyMap<string, SshConnectionState>
  testingIds: ReadonlySet<string>
  busyActionForTarget: (targetId: string) => SshTargetBusyAction | undefined
  selection: SshTargetSelection
  onConnect: (targetId: string) => void | Promise<void>
  onDisconnect: (targetId: string) => void | Promise<void>
  onTest: (targetId: string) => void | Promise<void>
  onEdit: (target: SshTarget) => void
  onRemove: (target: SshTarget) => void
  onServerChanged: () => void
}

function groupTitle(group: SshTargetGroup): React.JSX.Element {
  if (group.id === 'manual') {
    return <>{translate('auto.components.settings.SshTargetList.addedInOrca', 'Added in Orca')}</>
  }
  return <>{translate('auto.components.settings.SshTargetList.fromConfig', 'From ~/.ssh/config')}</>
}

// Virtualize generated configs with over 10k hosts; rendering every card consumed gigabytes of DOM.
const SSH_TARGET_ROW_ESTIMATE_PX = 52

const NOT_LIST_CONTEXT = '[role="dialog"], [role="alertdialog"], [role="menu"], pre, textarea'

/** Scope host select-all to list controls; React portal bubbling must not steal text selection in dialogs/menus/details. */
export function isListOwnSelectAllTarget(list: Element, target: EventTarget | null): boolean {
  if (!(target instanceof Element) || !list.contains(target)) {
    return false
  }
  if (
    target instanceof HTMLInputElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  ) {
    return false
  }
  return target.closest(NOT_LIST_CONTEXT) === null
}

export function SshTargetList({
  targets,
  totalBySource,
  connectionStates,
  testingIds,
  busyActionForTarget,
  selection,
  onConnect,
  onDisconnect,
  onTest,
  onEdit,
  onRemove,
  onServerChanged
}: SshTargetListProps): React.JSX.Element {
  const groups = groupSshTargetsBySource(targets)
  const scrollElement = useSettingsContentScrollElement()
  const isMac = navigator.userAgent.includes('Mac')

  return (
    <div
      className="space-y-3"
      onKeyDown={(event) => {
        const mod = isMac ? event.metaKey : event.ctrlKey
        if (
          mod &&
          event.key.toLowerCase() === 'a' &&
          isListOwnSelectAllTarget(event.currentTarget, event.target)
        ) {
          event.preventDefault()
          selection.setGroup(
            targets.map((target) => target.id),
            true
          )
        }
      }}
    >
      {groups.map((group) => {
        const ids = group.targets.map((target) => target.id)
        const checkState = sshTargetGroupCheckState(selection.selected, ids)
        return (
          <section
            key={group.id}
            data-ssh-target-group={group.id}
            className="overflow-hidden rounded-lg border border-border/60"
          >
            <div className="flex items-center gap-3 border-b border-border/60 bg-muted/30 px-3 py-2 has-[[data-slot=checkbox]:focus-visible]:ring-2 has-[[data-slot=checkbox]:focus-visible]:ring-ring/60 has-[[data-slot=checkbox]:focus-visible]:ring-inset">
              <Checkbox
                checked={checkState}
                aria-label={
                  group.id === 'manual'
                    ? translate(
                        'auto.components.settings.SshTargetList.selectManualGroup',
                        'Select all hosts added in Orca'
                      )
                    : translate(
                        'auto.components.settings.SshTargetList.selectConfigGroup',
                        'Select all hosts from ~/.ssh/config'
                      )
                }
                onCheckedChange={() => selection.setGroup(ids, checkState !== true)}
              />
              <span className="text-xs font-medium text-foreground">
                {groupTitle(group)}
                <span className="ml-1.5 font-normal text-muted-foreground tabular-nums">
                  ·{' '}
                  {group.targets.length < totalBySource[group.id]
                    ? translate(
                        'auto.components.settings.SshTargetList.filteredCount',
                        '{{count}} of {{total}}',
                        { count: group.targets.length, total: totalBySource[group.id] }
                      )
                    : group.targets.length}
                </span>
              </span>
            </div>
            <VirtualizedList
              rows={group.targets}
              getRowKey={(target) => target.id}
              scrollElement={scrollElement}
              estimateRowHeightPx={SSH_TARGET_ROW_ESTIMATE_PX}
              renderRow={(target) => (
                // Absolutely positioned virtual rows need individual borders; divide-y cannot reach them.
                <div
                  key={target.id}
                  data-first-row={target === group.targets[0] ? 'true' : undefined}
                  className="border-t border-border/40 data-[first-row=true]:border-t-0"
                >
                  <SshTargetCard
                    target={target}
                    state={connectionStates.get(target.id)}
                    testing={testingIds.has(target.id)}
                    busyAction={busyActionForTarget(target.id)}
                    selected={selection.selected.has(target.id)}
                    onSelectClick={selection.click}
                    onConnect={onConnect}
                    onDisconnect={onDisconnect}
                    onTest={onTest}
                    onEdit={onEdit}
                    onRemove={() => onRemove(target)}
                    onServerChanged={onServerChanged}
                  />
                </div>
              )}
            />
          </section>
        )
      })}
    </div>
  )
}

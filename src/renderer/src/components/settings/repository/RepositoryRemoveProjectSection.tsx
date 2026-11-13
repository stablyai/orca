import { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../../shared/execution-host'
import type { ProjectHostSetup } from '../../../../../shared/project-types'
import type { Repo } from '../../../../../shared/repo-types'
import { joinSentences } from '../../../../../shared/sentence-joining'
import type { SettingsProjectRemovalScope } from '../navigation/settings-project-list'
import { Button } from '../../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import type { SettingsSearchEntry } from '../search/settings-search'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { translateExecutionHostLabel } from '@/components/sidebar/execution-host-label'
import { countOpenRepoTerminalTabs } from '@/store/repos/repo-removal'
import { getRecipeVmRemovalTargets } from '@/store/repos/recipe-vm-project-removal'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'

type RemovedHostGroup = { hostId: ExecutionHostId; label: string; setups: ProjectHostSetup[] }

function getRemoveProjectDescription(
  scope: SettingsProjectRemovalScope,
  t: Translate = translate
): string {
  if (scope === 'checkout') {
    return t(
      'auto.components.settings.RepositoryPane.removeProjectCheckout',
      'Remove this checkout from Orca. Other checkouts of this project stay.'
    )
  }
  if (scope === 'split-project') {
    return t(
      'auto.components.settings.RepositoryPane.removeProjectKeepCheckouts',
      'Remove this project from Orca. Checkouts that have their own settings stay.'
    )
  }
  return t(
    'auto.components.settings.RepositoryPane.removeProjectAllHosts',
    'Remove this project from Orca on all configured hosts.'
  )
}

function selectSetupHostLabel(state: AppState, setup: ProjectHostSetup, t: Translate): string {
  const label = selectExecutionHostDisplayLabel(state, setup.hostId, {
    sshEnvironmentId: setup.runtimeOwnerEnvironmentId ?? null
  })
  const parsed = parseExecutionHostId(setup.hostId)
  const rawId =
    parsed?.kind === 'runtime'
      ? parsed.environmentId
      : parsed?.kind === 'ssh'
        ? parsed.targetId
        : null
  // An unlabeled host falls back to its raw id, which users can't recognize.
  return label === rawId
    ? t('auto.components.settings.RepositoryRemoveProjectSection.unknownHost', 'Unknown host')
    : translateExecutionHostLabel(label, t)
}

// Group by host, not label: two machines can share a display name.
function groupSetupsByHost(
  setups: readonly ProjectHostSetup[],
  hostLabels: readonly string[]
): RemovedHostGroup[] {
  const groups = new Map<ExecutionHostId, RemovedHostGroup>()
  setups.forEach((setup, index) => {
    const group = groups.get(setup.hostId)
    if (group) {
      group.setups.push(setup)
    } else {
      groups.set(setup.hostId, {
        hostId: setup.hostId,
        label: hostLabels[index] ?? '',
        setups: [setup]
      })
    }
  })
  return [...groups.values()]
}

function RemovedCheckoutList({ groups }: { groups: RemovedHostGroup[] }): React.JSX.Element {
  return (
    <ul className="space-y-2">
      {groups.map((group) => (
        <li key={group.hostId} className="space-y-0.5">
          <div className="text-xs font-medium text-foreground">{group.label}</div>
          {group.setups.map((setup) => (
            <div key={setup.id} className="break-all font-mono text-xs text-muted-foreground">
              {setup.path}
            </div>
          ))}
        </li>
      ))}
    </ul>
  )
}

function countSetupTerminalTabs(state: AppState, setups: readonly ProjectHostSetup[]): number {
  return setups.reduce(
    (count, setup) => count + countOpenRepoTerminalTabs(state, setup.repoId, setup.hostId),
    0
  )
}

export function RepositoryRemoveProjectSection({
  repo,
  setups,
  removalScope,
  searchEntry,
  forceVisible,
  removeProject
}: {
  repo: Repo
  setups: readonly ProjectHostSetup[]
  removalScope: SettingsProjectRemovalScope
  searchEntry: SettingsSearchEntry
  forceVisible: boolean
  removeProject: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [dialogOpen, setDialogOpen] = useState(false)
  // Read once on open: a live subscription would walk every tab on each store write.
  const [openTerminalCount, setOpenTerminalCount] = useState(0)
  const hostLabels = useAppStore(
    useShallow((state) => setups.map((setup) => selectSetupHostLabel(state, setup, t)))
  )
  // Select only these repos' lists so writes to other repos don't re-render this pane.
  const setupWorktrees = useAppStore(
    useShallow((state) => setups.map((setup) => selectWorktreesByRepo(state)[setup.repoId]))
  )
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  // Removal can destroy a recipe VM, where "files stay on disk" would be false.
  const removesRecipeVm = useMemo(
    () =>
      setups.some(
        (setup, index) =>
          getRecipeVmRemovalTargets(
            {
              worktreesByRepo: { [setup.repoId]: setupWorktrees[index] ?? [] },
              runtimeEnvironments
            },
            { id: setup.repoId, connectionId: setup.connectionId },
            setup.hostId
          ) !== null
      ),
    [setups, setupWorktrees, runtimeEnvironments]
  )
  const groups = useMemo(() => groupSetupsByHost(setups, hostLabels), [setups, hostLabels])
  const hostCount = new Set(setups.map((setup) => setup.hostId)).size
  const description = getRemoveProjectDescription(removalScope, t)

  const filesNote = removesRecipeVm
    ? t(
        'auto.components.settings.RepositoryRemoveProjectSection.filesNoteVmRecipe',
        'VM recipes decide whether their environments and files are deleted.'
      )
    : t(
        'auto.components.settings.RepositoryRemoveProjectSection.filesNote',
        'Files stay on disk, so you can add it again later.'
      )
  const summary = [
    t('auto.components.settings.RepositoryRemoveProjectSection.hostCount', '{{count}} hosts', {
      count: hostCount,
      defaultValue_one: '{{count}} host'
    }),
    t(
      'auto.components.settings.RepositoryRemoveProjectSection.checkoutCount',
      '{{count}} checkouts',
      { count: setups.length, defaultValue_one: '{{count}} checkout' }
    )
  ].join(' · ')

  const confirmRemove = (): void => {
    // Terminals opened elsewhere while confirming must be shown before they are closed.
    const currentTerminalCount = countSetupTerminalTabs(useAppStore.getState(), setups)
    if (currentTerminalCount > openTerminalCount) {
      setOpenTerminalCount(currentTerminalCount)
      return
    }
    setDialogOpen(false)
    removeProject()
  }

  return (
    <SettingsGroup
      title={t('auto.components.settings.RepositoryPane.04eebebbea', 'Remove project')}
    >
      <SearchableSetting
        title={searchEntry.title}
        description={searchEntry.description}
        keywords={searchEntry.keywords}
        className="space-y-2 py-3"
        forceVisible={forceVisible}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <p className="text-sm">{description}</p>
            <p className="text-xs text-muted-foreground">{filesNote}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setOpenTerminalCount(countSetupTerminalTabs(useAppStore.getState(), setups))
              setDialogOpen(true)
            }}
          >
            {t('auto.components.settings.RepositoryRemoveProjectSection.removeButton', 'Remove…')}
          </Button>
        </div>
        {groups.length > 0 ? (
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="xs" className="-ml-2">
                <ChevronRight className="transition-transform in-data-[state=open]:rotate-90" />
                {summary}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="pt-2 pl-4">
                <RemovedCheckoutList groups={groups} />
              </div>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </SearchableSetting>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent surface="security" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {t(
                'auto.components.settings.RepositoryRemoveProjectSection.dialogTitle',
                'Remove {{name}}?',
                { name: repo.displayName }
              )}
            </DialogTitle>
            <DialogDescription>{joinSentences([description, filesNote])}</DialogDescription>
          </DialogHeader>
          {groups.length > 0 ? (
            <div className="scrollbar-sleek max-h-64 overflow-y-auto rounded-md border border-border p-3">
              <RemovedCheckoutList groups={groups} />
            </div>
          ) : null}
          {openTerminalCount > 0 ? (
            <p className="text-xs font-medium text-foreground">
              {t(
                'auto.components.settings.RepositoryRemoveProjectSection.terminalWarning',
                '{{count}} open terminals in this project will be closed.',
                {
                  count: openTerminalCount,
                  defaultValue_one: '{{count}} open terminal in this project will be closed.'
                }
              )}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              {t('auto.components.settings.RepositoryRemoveProjectSection.cancel', 'Cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmRemove}>
              {t('auto.components.settings.RepositoryRemoveProjectSection.confirm', 'Remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  )
}

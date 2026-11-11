import { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { ProjectHostSetup } from '../../../../../shared/project-types'
import type { Repo } from '../../../../../shared/repo-types'
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
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { countOpenRepoTerminalTabs } from '@/store/repos/repo-removal'
import { getRecipeVmRemovalTargets } from '@/store/repos/recipe-vm-project-removal'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'

type RemovedHostGroup = { label: string; paths: string[] }

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

// Group by display name so the list reads as machines; raw host IDs are never shown.
function groupSetupsByHost(
  setups: readonly ProjectHostSetup[],
  hostLabels: readonly string[]
): RemovedHostGroup[] {
  const groups = new Map<string, string[]>()
  setups.forEach((setup, index) => {
    const label = hostLabels[index] ?? ''
    groups.set(label, [...(groups.get(label) ?? []), setup.path])
  })
  return [...groups].map(([label, paths]) => ({ label, paths }))
}

function RemovedCheckoutList({ groups }: { groups: RemovedHostGroup[] }): React.JSX.Element {
  return (
    <ul className="space-y-2">
      {groups.map((group) => (
        <li key={group.label} className="space-y-0.5">
          <div className="text-xs font-medium text-foreground">{group.label}</div>
          {group.paths.map((path) => (
            <div key={path} className="break-all font-mono text-xs text-muted-foreground">
              {path}
            </div>
          ))}
        </li>
      ))}
    </ul>
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
  const hostLabels = useAppStore(
    useShallow((state) =>
      setups.map((setup) => selectExecutionHostDisplayLabel(state, setup.hostId))
    )
  )
  const openTerminalCount = useAppStore((state) =>
    setups.reduce(
      (count, setup) => count + countOpenRepoTerminalTabs(state, setup.repoId, setup.hostId),
      0
    )
  )
  // Removal can destroy a recipe VM, where "files stay on disk" would be false.
  const removesRecipeVm = useAppStore((state) =>
    setups.some(
      (setup) =>
        getRecipeVmRemovalTargets(
          state,
          { id: setup.repoId, connectionId: setup.connectionId },
          setup.hostId
        ) !== null
    )
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
  const summaryParts = [
    t('auto.components.settings.RepositoryRemoveProjectSection.hostCount', '{{count}} hosts', {
      count: hostCount,
      defaultValue_one: '{{count}} host'
    }),
    t(
      'auto.components.settings.RepositoryRemoveProjectSection.checkoutCount',
      '{{count}} checkouts',
      { count: setups.length, defaultValue_one: '{{count}} checkout' }
    )
  ]
  if (openTerminalCount > 0) {
    summaryParts.push(
      t(
        'auto.components.settings.RepositoryRemoveProjectSection.terminalCount',
        '{{count}} open terminals',
        { count: openTerminalCount, defaultValue_one: '{{count}} open terminal' }
      )
    )
  }

  const confirmRemove = (): void => {
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
          <Button type="button" variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
            {t('auto.components.settings.RepositoryRemoveProjectSection.removeButton', 'Remove…')}
          </Button>
        </div>
        {groups.length > 0 ? (
          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
              {summaryParts.join(' · ')}
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2 pl-4">
              <RemovedCheckoutList groups={groups} />
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </SearchableSetting>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent surface="security" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">
              {t(
                'auto.components.settings.RepositoryRemoveProjectSection.dialogTitle',
                'Remove {{name}}?',
                { name: repo.displayName }
              )}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {description} {filesNote}
            </DialogDescription>
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

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { HostCombobox } from '@/components/host-picker/HostCombobox'
import { useAppStore } from '@/store'
import { defaultScopeHost } from '@/lib/default-creation-host'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { resolveSettingsHostScope } from '../settings/settings-host-scope'
import { translate } from '@/i18n/i18n'
import { loadHistoryRuns, type HistoryRun } from './run-history-client'
import { useRunHistoryPages } from './use-run-history-pages'
import { RunHistoryRuns } from './RunHistoryRuns'
import { RunHistoryDetail } from './RunHistoryDetail'

function HostHistory({
  environmentId,
  onReveal
}: {
  environmentId: string | null
  onReveal: () => void
}) {
  const load = useCallback(
    (cursor: string | undefined, signal: AbortSignal) =>
      loadHistoryRuns(environmentId, cursor, signal),
    [environmentId]
  )
  const page = useRunHistoryPages(load)
  const [selected, setSelected] = useState<HistoryRun | null>(null)
  return selected ? (
    <RunHistoryDetail
      key={selected.id}
      environmentId={environmentId}
      run={selected}
      onBack={() => setSelected(null)}
      onReveal={onReveal}
    />
  ) : (
    <RunHistoryRuns
      page={page}
      onChoose={setSelected}
      onRefresh={page.refresh}
      onRetry={page.retry}
      onLoadMore={page.loadMore}
    />
  )
}

export function RunHistoryBrowser({
  onBack,
  onClose,
  onReveal
}: {
  onBack: () => void
  onClose: () => void
  onReveal: () => void
}) {
  useTranslation()
  const environments = useAppStore((state) => state.runtimeEnvironments)
  const hydrated = useAppStore((state) => state.runtimeEnvironmentCatalogHydrated)
  const [choice, setChoice] = useState<RuntimeClientTarget>(() =>
    isPairedWebClientWindow()
      ? { kind: 'local' }
      : defaultScopeHost(useAppStore.getState().settings)
  )
  const scope = resolveSettingsHostScope({
    choice,
    savedEnvironmentIds: environments.map((environment) => environment.id),
    catalogHydrated: hydrated,
    defaultEnvironmentId: null
  })
  const environmentId = scope.target.kind === 'environment' ? scope.target.environmentId : null
  const environment = environments.find((candidate) => candidate.id === environmentId)
  const options = [
    { id: 'local', label: getLocalExecutionHostLabel() },
    ...environments.map((candidate) => ({
      id: `environment:${candidate.id}`,
      label: candidate.name
    })),
    ...(environmentId && !environment
      ? [{ id: `environment:${environmentId}`, label: environmentId, disabled: true }]
      : [])
  ]
  return (
    <section
      aria-label={translate('orchestrationHistory.title', 'Run history')}
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
    >
      <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          {translate('dashboardPopout.title', 'Agents')}
        </Button>
        <h1 className="flex-1 text-sm font-semibold">
          {translate('orchestrationHistory.title', 'Run history')}
        </h1>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label={translate('orchestrationHistory.close', 'Close run history')}
            >
              <X aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate('orchestrationHistory.close', 'Close run history')}
          </TooltipContent>
        </Tooltip>
      </header>
      {!isPairedWebClientWindow() ? (
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <span className="text-xs font-medium">
            {translate('auto.components.settings.SettingsHostScopePicker.label', 'Host')}
          </span>
          <HostCombobox
            ariaLabel={translate('auto.components.settings.SettingsHostScopePicker.label', 'Host')}
            size="sm"
            className="max-w-xs"
            options={options}
            value={environmentId ? `environment:${environmentId}` : 'local'}
            onChange={(value) =>
              setChoice(
                value === 'local'
                  ? { kind: 'local' }
                  : { kind: 'environment', environmentId: value.slice('environment:'.length) }
              )
            }
          />
        </div>
      ) : null}
      {scope.available ? (
        <HostHistory
          key={JSON.stringify([scope.target, environment?.pairingRevision, environment?.runtimeId])}
          environmentId={environmentId}
          onReveal={onReveal}
        />
      ) : (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          {translate(
            'orchestrationHistory.hostUnavailable',
            'This host is no longer saved. Choose another host to read its runs.'
          )}
        </p>
      )}
    </section>
  )
}

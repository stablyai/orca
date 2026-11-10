import { useState } from 'react'
import { Bot, Boxes, Hammer, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type { BuildLogBuffer } from './build-log-model'
import { BuildHistoryList } from './BuildHistoryList'
import { BuildLogViewer, type BuildLogStreamState } from './BuildLogViewer'
import {
  isBuildInProgress,
  repoDisplayName,
  type StalenessBannerCopy
} from './cloud-environment-copy'
import type {
  EnvironmentBuildView,
  EnvironmentDraft,
  EnvironmentView
} from './cloud-environment-types'
import { draftFromEnvironment } from './environment-draft'
import { EnvironmentForm, EnvironmentSummary, type EnvironmentFormProps } from './EnvironmentForm'
import { StalenessBanner } from './StalenessBanner'

function SubsectionTitle({
  children,
  action
}: {
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3">
      <h4 className="text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
        {children}
      </h4>
      {action}
    </div>
  )
}

export type CloudEnvironmentPanelProps = {
  environment: EnvironmentView
  /** The environment the form draft started from (defaults to `environment`). */
  formEnvironment?: EnvironmentView | null
  builds: readonly EnvironmentBuildView[]
  canAdmin: boolean
  /** Fixed clock for fixtures; live views tick inside the history list only. */
  now?: number
  selectedBuild: EnvironmentBuildView | null
  log: {
    buffer: BuildLogBuffer
    state: BuildLogStreamState
    error: string | null
    onRetry: () => void
  } | null
  staleness: StalenessBannerCopy | null
  starting: boolean
  busyBuildId: string | null
  actionError: string | null
  actorName?: (actor: string) => string
  /** Configure-with-agent is possible (a local project to run in exists). */
  agentAvailable: boolean
  agentLaunching: boolean
  form: Pick<
    EnvironmentFormProps,
    | 'saving'
    | 'error'
    | 'conflict'
    | 'conflictEditor'
    | 'suggestions'
    | 'importProjects'
    | 'onReadImports'
    | 'onReload'
  > & {
    onSave: (draft: EnvironmentDraft) => void
    initialDraft?: EnvironmentDraft
  }
  onBuild: () => void
  onCancel: (build: EnvironmentBuildView) => void
  onActivate: (build: EnvironmentBuildView) => void
  onSelectBuild: (build: EnvironmentBuildView) => void
  onConfigureWithAgent: () => void
  /** Render the log viewer at a fixed clock (fixtures). */
  frozenNow?: number
}

export function CloudEnvironmentPanel(props: CloudEnvironmentPanelProps): React.JSX.Element {
  const t = useTranslate()
  const { environment, builds, canAdmin, selectedBuild, log, staleness, starting, actionError } =
    props
  const activeBuild = builds.find((build) => build.active) ?? null
  const inProgress = builds.some((build) => isBuildInProgress(build.status))
  const formEnvironment = props.formEnvironment ?? environment
  const bannerOffersRebuild = staleness !== null && staleness.rebuild && !inProgress
  const base = draftFromEnvironment(formEnvironment)
  const [configOpen, setConfigOpen] = useState(builds.length === 0)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
          <Boxes aria-hidden className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium">
            {activeBuild
              ? t('cloudEnvironment.header.active', 'New workspaces start from build #{{number}}', {
                  number: String(activeBuild.number)
                })
              : t(
                  'cloudEnvironment.header.noActive',
                  'No build yet: workspaces start from a fresh sandbox'
                )}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {environment.repos.map((repo) => repoDisplayName(repo.url)).join(', ')}
          </p>
        </div>
        {canAdmin ? (
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!props.agentAvailable || props.agentLaunching}
              onClick={props.onConfigureWithAgent}
              title={
                props.agentAvailable
                  ? t(
                      'cloudEnvironment.agent.hint',
                      'Starts your default agent in a local checkout. It writes the install script and builds until it succeeds.'
                    )
                  : t(
                      'cloudEnvironment.agent.noRepo',
                      'Add a local project for one of these repositories first.'
                    )
              }
            >
              {props.agentLaunching ? (
                <Loader2 className="animate-spin motion-reduce:animate-none" />
              ) : (
                <Bot />
              )}
              {t('cloudEnvironment.agent.button', 'Configure with an agent')}
            </Button>
            {/* One Rebuild per view: a staleness banner that offers one owns it. */}
            {bannerOffersRebuild ? null : (
              <Button
                type="button"
                size="sm"
                variant={builds.length === 0 ? 'default' : 'outline'}
                disabled={starting || inProgress}
                onClick={props.onBuild}
              >
                {starting ? (
                  <Loader2 className="animate-spin motion-reduce:animate-none" />
                ) : builds.length === 0 ? (
                  <Hammer />
                ) : (
                  <RefreshCw />
                )}
                {builds.length === 0
                  ? t('cloudEnvironment.buildNow', 'Build now')
                  : t('cloudEnvironment.rebuild', 'Rebuild')}
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {actionError ? <InlineError title={actionError} /> : null}

      {staleness && !inProgress ? (
        <StalenessBanner
          copy={staleness}
          canAdmin={canAdmin}
          building={starting || inProgress}
          onRebuild={props.onBuild}
        />
      ) : null}

      {selectedBuild && log ? (
        <BuildLogViewer
          key={selectedBuild.id}
          build={selectedBuild}
          buffer={log.buffer}
          activeBuildNumber={activeBuild?.number ?? null}
          streamState={log.state}
          streamError={log.error}
          onRetryStream={log.onRetry}
          now={props.frozenNow}
        />
      ) : null}

      <section className="space-y-2" aria-labelledby="cloud-env-history">
        <SubsectionTitle>
          <span id="cloud-env-history">{t('cloudEnvironment.history.title', 'Builds')}</span>
        </SubsectionTitle>
        <BuildHistoryList
          builds={builds}
          selectedBuildId={selectedBuild?.id ?? null}
          canAdmin={canAdmin}
          busyBuildId={props.busyBuildId}
          now={props.now}
          actorName={props.actorName}
          onSelect={props.onSelectBuild}
          onCancel={props.onCancel}
          onActivate={props.onActivate}
        />
      </section>

      <section className="space-y-3" aria-labelledby="cloud-env-config">
        <SubsectionTitle
          action={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-expanded={configOpen}
              aria-controls="cloud-env-config-body"
              onClick={() => setConfigOpen((open) => !open)}
            >
              {configOpen
                ? t('cloudEnvironment.config.hide', 'Hide')
                : canAdmin
                  ? t('cloudEnvironment.config.edit', 'Edit')
                  : t('cloudEnvironment.config.show', 'Show')}
            </Button>
          }
        >
          <span id="cloud-env-config">{t('cloudEnvironment.config.title', 'Configuration')}</span>
        </SubsectionTitle>
        <div id="cloud-env-config-body" className={cn(!configOpen && 'hidden')}>
          {canAdmin ? (
            <EnvironmentForm
              // A new revision (ours or someone else's after reload) starts a clean draft.
              key={formEnvironment.revision}
              mode="edit"
              base={base}
              {...props.form}
            />
          ) : (
            <EnvironmentSummary base={draftFromEnvironment(environment)} />
          )}
        </div>
      </section>
    </div>
  )
}

export function CloudEnvironmentEmptyState({
  canAdmin,
  onStart
}: {
  canAdmin: boolean
  onStart: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-10 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Boxes aria-hidden className="size-5 text-muted-foreground" />
      </div>
      <div className="max-w-md space-y-1">
        <p className="text-sm font-medium">
          {t('cloudEnvironment.empty.title', 'Create your environment')}
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          {t(
            'cloudEnvironment.empty.description',
            'Install your repos’ dependencies once, snapshot the sandbox, and every new cloud workspace starts ready to run in seconds.'
          )}
        </p>
      </div>
      {canAdmin ? (
        <Button type="button" size="sm" onClick={onStart}>
          {t('cloudEnvironment.empty.cta', 'Create environment')}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t('cloudEnvironment.empty.memberAsk', 'Ask an owner or admin to set it up.')}
        </p>
      )}
    </div>
  )
}

/** Loading placeholder shaped like the panel (header row, banner, log). */
export function CloudEnvironmentSkeleton(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-4" aria-busy="true">
      <span className="sr-only" role="status">
        {t('cloudEnvironment.loading', 'Loading environment…')}
      </span>
      <div className="flex items-center gap-3">
        <Skeleton className="size-9" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3.5 w-64" />
          <Skeleton className="h-3 w-40" />
        </div>
        <Skeleton className="h-8 w-28" />
      </div>
      <Skeleton shape="card" className="h-48 w-full" />
      <div className="space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  )
}

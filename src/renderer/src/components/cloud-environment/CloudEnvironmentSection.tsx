import { useEffect, useMemo, useState } from 'react'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { InlineError } from '@/components/ui/inline-error'
import { SettingsGroupHeader } from '@/components/settings/section-layout/SettingsGroup'
import { useTranslate } from '@/i18n/use-translate'
import {
  githubSlugForRepo,
  launchCloudEnvironmentAgent,
  pickCloudEnvironmentAgentRepo
} from '@/lib/cloud-environment-agent-launch'
import { useAppStore } from '@/store/index'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { OrcaOrgMember } from '../../../../shared/orca-profiles'
import { stalenessBannerCopy } from './cloud-environment-copy'
import type {
  EnvironmentBuildView,
  EnvironmentDraft,
  EnvironmentsApi
} from './cloud-environment-types'
import {
  CloudEnvironmentEmptyState,
  CloudEnvironmentSkeleton,
  CloudEnvironmentPanel
} from './CloudEnvironmentPanel'
import { emptyDraft } from './environment-draft'
import { EnvironmentForm } from './EnvironmentForm'
import type { LocalRepoSuggestion } from './EnvironmentFormFields'
import { useBuildLogStream } from './use-build-log-stream'
import { useCloudEnvironment } from './use-cloud-environment'

const LOG_TAIL_LINES = 80

/** Hidden unless this build talks to an Orca Cloud control plane. */
export function useOrcaCloudEnvironmentsConfigured(): boolean {
  const [configured, setConfigured] = useState(false)
  useEffect(() => {
    let disposed = false
    void window.api.orcaCloudEnvironments
      ?.isConfigured()
      .then((value) => {
        if (!disposed) {
          setConfigured(value)
        }
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [])
  return configured
}

function useLocalRepoSuggestions(): {
  suggestions: LocalRepoSuggestion[]
  importProjects: LocalRepoSuggestion[]
} {
  const repos = useAppStore((state) => state.repos)
  return useMemo(() => {
    const local = repos.filter((repo) => isGitRepoKind(repo) && !repo.connectionId)
    const importProjects = local.map((repo) => ({
      repoId: repo.id,
      slug: githubSlugForRepo(repo) ?? '',
      path: repo.path,
      displayName: repo.displayName
    }))
    return {
      suggestions: importProjects.filter((entry) => entry.slug !== ''),
      importProjects
    }
  }, [repos])
}

/** Settings block: Orca Cloud environment (repos + install script → snapshot builds). */
export function CloudEnvironmentSection({
  orgId,
  viewerUserId
}: {
  orgId: string | null
  viewerUserId: string | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const configured = useOrcaCloudEnvironmentsConfigured()
  if (!configured) {
    return null
  }
  return (
    <section
      className="space-y-4 border-t border-border/60 pt-5"
      aria-labelledby="cloud-environment-title"
    >
      <SettingsGroupHeader
        className="px-0"
        title={
          <span id="cloud-environment-title">
            {t('cloudEnvironment.title', 'Cloud environment')}
          </span>
        }
        description={t(
          'cloudEnvironment.descriptionTeam',
          'Your team’s repos and install script, built once into a snapshot so every cloud workspace starts with dependencies installed.'
        )}
      />
      <CloudEnvironmentController
        api={window.api.orcaCloudEnvironments}
        orgId={orgId}
        viewerUserId={viewerUserId}
      />
    </section>
  )
}

function useActorName(
  orgId: string | null,
  viewerUserId: string | null
): (actor: string) => string {
  const t = useTranslate()
  const [members, setMembers] = useState<OrcaOrgMember[]>([])
  useEffect(() => {
    if (!orgId) {
      return
    }
    let disposed = false
    void window.api.orcaProfiles
      .orgMembersList({ orgId })
      .then((result) => {
        if (!disposed && result.status === 'ok') {
          setMembers(result.roster.members)
        }
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [orgId])
  return useMemo(() => {
    const you = t('cloudEnvironment.you', 'You')
    return (actor: string) => {
      if (actor === viewerUserId) {
        return you
      }
      const member = members.find((entry) => entry.userId === actor)
      return member ? member.displayName?.trim() || member.email : actor
    }
  }, [members, viewerUserId, t])
}

function CloudEnvironmentController({
  api,
  orgId,
  viewerUserId
}: {
  api: EnvironmentsApi
  orgId: string | null
  viewerUserId: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const env = useCloudEnvironment(api)
  const { suggestions, importProjects } = useLocalRepoSuggestions()
  const repos = useAppStore((state) => state.repos)
  const activeRepoId = useAppStore((state) => state.activeRepoId)
  const actorName = useActorName(orgId, viewerUserId)
  const [creating, setCreating] = useState(false)
  const [selectedBuildId, setSelectedBuildId] = useState<string | null>(null)
  const [agentLaunching, setAgentLaunching] = useState(false)

  const ready = env.load.phase === 'ready' ? env.load : null
  const builds = ready?.builds ?? []
  const selectedBuild = builds.find((build) => build.id === selectedBuildId) ?? builds[0] ?? null
  const stream = useBuildLogStream(
    api,
    ready?.environment.id ?? null,
    selectedBuild?.id ?? null,
    env.applyBuild,
    env.refreshAfterBuildEnd
  )

  if (env.load.phase === 'loading') {
    return <CloudEnvironmentSkeleton />
  }
  if (env.load.phase === 'error') {
    const { error } = env.load
    const entitlement = error.code === 'forbidden' && error.reason !== 'admin_required'
    return (
      <InlineError
        tone={entitlement || error.code === 'unauthorized' ? 'neutral' : 'error'}
        title={
          entitlement || error.code === 'unauthorized'
            ? error.message
            : t('cloudEnvironment.loadFailed', 'Couldn’t load the cloud environment')
        }
        detail={entitlement || error.code === 'unauthorized' ? undefined : error.message}
        retryLabel={t('cloudEnvironment.retry', 'Try again')}
        onRetry={env.reload}
      />
    )
  }

  const readImports = (path: string) => api.readRepoSetupImports(path)

  if (env.load.phase === 'none') {
    if (!creating) {
      return (
        <CloudEnvironmentEmptyState
          canAdmin={env.load.canAdmin}
          onStart={() => setCreating(true)}
        />
      )
    }
    const prefill = pickCloudEnvironmentAgentRepo(repos, [], activeRepoId)
    const prefillSlug = prefill ? githubSlugForRepo(prefill) : null
    return (
      <EnvironmentForm
        mode="create"
        base={emptyDraft(prefillSlug ? [prefillSlug] : [])}
        saving={env.actions.saving}
        error={env.actions.saveError}
        conflict={false}
        suggestions={suggestions}
        importProjects={importProjects}
        onReadImports={readImports}
        onCancel={() => setCreating(false)}
        onSave={(draft: EnvironmentDraft) => {
          void env.create(draft).then((build) => {
            if (build) {
              setSelectedBuildId(build.id)
            }
            setCreating(false)
          })
        }}
      />
    )
  }

  const { environment, canAdmin } = env.load
  const activeBuild = builds.find((build) => build.active) ?? null
  // The stream's view of the selected build is fresher than the list until the next poll.
  const streamedBuild =
    stream.build && selectedBuild && stream.build.id === selectedBuild.id ? stream.build : null
  const logBuild = streamedBuild ?? selectedBuild
  const agentRepo = pickCloudEnvironmentAgentRepo(
    repos,
    environment.repos.map((repo) => repo.url),
    activeRepoId
  )

  const configureWithAgent = (): void => {
    if (!agentRepo) {
      return
    }
    const latest = builds[0]
    const failure =
      latest && latest.status === 'failed'
        ? {
            buildNumber: latest.number,
            failedStep: latest.failedStep,
            error: latest.error,
            log:
              latest.id === logBuild?.id
                ? stream.buffer.lines
                    .slice(-LOG_TAIL_LINES)
                    .map((line) => line.plain)
                    .join('\n')
                : undefined
          }
        : undefined
    setAgentLaunching(true)
    void launchCloudEnvironmentAgent({
      repoId: agentRepo.id,
      envId: environment.id,
      environmentName: environment.name,
      repos: environment.repos.map((repo) => repo.url),
      envVarNames: environment.envVarNames,
      ...(failure ? { failure } : {})
    })
      .catch(() => false)
      .then(() => setAgentLaunching(false))
  }

  const activate = (build: EnvironmentBuildView): void => {
    void confirm({
      title: t('cloudEnvironment.activate.title', 'Use build #{{number}}?', {
        number: String(build.number)
      }),
      description: t(
        'cloudEnvironment.activate.description',
        'New workspaces will start from build #{{number}}. Existing workspaces keep theirs.',
        { number: String(build.number) }
      ),
      confirmLabel: t('cloudEnvironment.activate.confirm', 'Use this build')
    }).then((accepted) => {
      if (accepted) {
        void env.activate(build)
      }
    })
  }

  return (
    <CloudEnvironmentPanel
      environment={environment}
      formEnvironment={env.formBase}
      builds={builds}
      canAdmin={canAdmin}
      selectedBuild={logBuild}
      log={
        logBuild
          ? {
              buffer: stream.buffer,
              state: stream.state,
              error: stream.error,
              onRetry: stream.retry
            }
          : null
      }
      staleness={stalenessBannerCopy(env.staleness, activeBuild?.number ?? null, t)}
      starting={env.actions.starting}
      busyBuildId={env.actions.busyBuildId}
      actionError={env.actions.actionError}
      actorName={actorName}
      agentAvailable={agentRepo !== null}
      agentLaunching={agentLaunching}
      form={{
        saving: env.actions.saving,
        error: env.actions.saveError,
        conflict: env.actions.conflict,
        conflictEditor:
          env.actions.conflict && env.formBase && env.formBase.revision !== environment.revision
            ? actorName(environment.updatedBy)
            : null,
        suggestions,
        importProjects,
        onReadImports: readImports,
        onReload: env.reloadAfterConflict,
        onSave: (draft) => void env.save(env.formBase ?? environment, draft)
      }}
      onBuild={() => {
        void env.startBuild(environment.id).then((build) => {
          if (build) {
            setSelectedBuildId(build.id)
          }
        })
      }}
      onCancel={(build) => void env.cancel(build)}
      onActivate={activate}
      onSelectBuild={(build) => setSelectedBuildId(build.id)}
      onConfigureWithAgent={configureWithAgent}
    />
  )
}

import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { useLiveDashboardSnapshot } from '../dashboard/snapshot/useLiveDashboardSnapshot'
import { projectCommanderAgents } from './commander-project-overview'
import {
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { getProjectIdentityKey } from '../../../../shared/project/host-setup/project-host-setup-projection'
import type { RuntimeStatus } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RuntimeWorktreePsResult } from '../../../../shared/worktree/catalog/runtime-worktree-contracts'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  checkpointMarkdown,
  checkpointObservation,
  checkpointSources,
  confirmsNoAgents,
  type CheckpointSource
} from './commander-checkpoint-content'
import { reportCheckpointError, useRecordingDevice } from './CommanderRecording'
import type { CommanderAccount } from '../../../../shared/commander/memory-contract'

async function checkpointId(device: string, project: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([device, project]))
  )
  return `checkpoint-${Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join('')}`
}

function Publisher({ account, device }: { account: CommanderAccount; device: string }): null {
  const t = useTranslate()
  const { cards } = useLiveDashboardSnapshot()
  const repos = useAppStore((s) => s.repos)
  const hydrated = useAppStore(
    (s) =>
      s.workspaceSessionReady &&
      s.terminalStartupRestorationReady &&
      s.runtimeEnvironmentCatalogHydrated
  )
  const registrations = useMemo(() => Map.groupBy(repos, getProjectIdentityKey), [repos])
  const projects = useMemo(
    () =>
      hydrated
        ? projectCommanderAgents(repos, cards).map((project) => ({
            ...project,
            registrations: (registrations.get(project.id) ?? []).map((repo) => ({
              hostId: getRepoExecutionHostId(repo),
              repoId: repo.id
            })),
            sources: project.cards.map((card) => ({
              hostId: card.executionHostId ?? '',
              repoId: card.repoId,
              worktreeId: card.worktreeId
            }))
          }))
        : [],
    [repos, cards, hydrated, registrations]
  )
  const latest = useRef(projects)
  const onChange = useRef<(() => void) | null>(null)
  useEffect(() => {
    latest.current = projects
    onChange.current?.()
  }, [projects])
  useEffect(() => {
    const api = window.api.commanderMemory
    if (!api) {
      return
    }
    let closed = false
    let running = false
    let pending = false
    let nextAttempt = 0
    let retryDelay = 30_000
    let timer: ReturnType<typeof setTimeout> | undefined
    const saved = new Map<string, string>()
    function schedule(): void {
      pending = true
      if (!closed && !running && !timer) {
        timer = setTimeout(() => void tick(), Math.max(1500, nextAttempt - Date.now()))
      }
    }
    async function tick(): Promise<void> {
      timer = undefined
      pending = false
      running = true
      let retry = false
      try {
        const sample = latest.current
        const listings = new Map<string, Promise<RuntimeWorktreePsResult | null>>()
        async function sourceIsEmpty(source: CheckpointSource): Promise<boolean> {
          const host = parseExecutionHostId(source.hostId)
          if (
            !host ||
            (host.kind === 'ssh' &&
              useAppStore.getState().sshConnectionStates.get(host.targetId)?.status !== 'connected')
          ) {
            return false
          }
          const target =
            host.kind === 'runtime'
              ? { kind: 'environment' as const, environmentId: host.environmentId }
              : { kind: 'local' as const }
          const key = JSON.stringify(target)
          let listing = listings.get(key)
          if (!listing) {
            listing = (async () => {
              const status = await callRuntimeRpc<RuntimeStatus>(target, 'status.get', undefined, {
                timeoutMs: 10000
              })
              if (status.graphStatus !== 'ready') {
                return null
              }
              const census = await callRuntimeRpc<RuntimeWorktreePsResult>(
                target,
                'worktree.ps',
                { limit: 10000 },
                {
                  expectedEnvironmentRuntimeId: status.runtimeId,
                  timeoutMs: 10000
                }
              )
              const after = await callRuntimeRpc<RuntimeStatus>(target, 'status.get', undefined, {
                timeoutMs: 10000,
                expectedEnvironmentRuntimeId: status.runtimeId
              })
              return after.graphStatus === 'ready' &&
                after.runtimeId === status.runtimeId &&
                after.rendererGraphEpoch === status.rendererGraphEpoch
                ? census
                : null
            })().catch(() => null)
            listings.set(key, listing)
          }
          const result = await listing
          return (
            !!result &&
            confirmsNoAgents(
              result,
              source.repoId,
              host.kind === 'runtime' ? 'local' : host.id,
              source.worktreeId
            )
          )
        }
        const changed = sample
          .map((project) => ({
            project,
            body: checkpointObservation(checkpointMarkdown(project.cards), project.sources)
          }))
          .filter(({ project, body }) => saved.get(project.id) !== body)
        if (changed.length) {
          const { pages } = await api.list(account)
          let failure = ''
          for (const { project, body: candidate } of changed) {
            try {
              const pageId = await checkpointId(device, project.id)
              if (closed) {
                return
              }
              const page = pages.find((p) => p.pageId === pageId)
              if (
                page?.deleted ||
                (page && (page.actor.type !== 'commander' || page.actor.id !== 'orca-checkpoint'))
              ) {
                saved.set(project.id, candidate)
                continue
              }
              const previousSources = checkpointSources(page?.body ?? '')
              const empty = project.cards.length === 0
              if (empty && (!page || !previousSources.length)) {
                saved.set(project.id, candidate)
                continue
              }
              const missing = previousSources.filter(
                (previous) =>
                  !project.sources.some(
                    (source) =>
                      source.hostId === previous.hostId && source.repoId === previous.repoId
                  )
              )
              const toConfirm = empty ? [...previousSources, ...project.registrations] : missing
              if (!(await Promise.all(toConfirm.map(sourceIsEmpty))).every(Boolean)) {
                retry = true
                continue
              }
              const body = empty ? checkpointObservation('', toConfirm) : candidate
              if (closed) {
                return
              }
              if (latest.current !== sample) {
                const current = latest.current.find((row) => row.id === project.id)
                if (
                  !current ||
                  checkpointObservation(checkpointMarkdown(current.cards), current.sources) !==
                    candidate ||
                  JSON.stringify(current.registrations) !== JSON.stringify(project.registrations)
                ) {
                  pending = true
                  continue
                }
              }
              if (page?.body !== body) {
                await api.checkpoint(account, {
                  pageId,
                  projectId: project.id,
                  kind: 'note',
                  title: t('commander.recording.title', '{{project}} · progress · {{device}}', {
                    project: project.name.slice(0, 100),
                    device: device.slice(0, 8)
                  }),
                  body,
                  expectedVersion: page?.version ?? 0,
                  links: [],
                  requestId: createBrowserUuid()
                })
              }
              saved.set(project.id, candidate)
            } catch (error) {
              retry = true
              failure =
                error instanceof Error
                  ? error.message
                  : t('commander.recording.unavailable', 'Unavailable')
            }
          }
          if (!closed) {
            reportCheckpointError(account, failure)
          }
        }
      } catch (error) {
        retry = true
        if (!closed) {
          reportCheckpointError(
            account,
            error instanceof Error
              ? error.message
              : t('commander.recording.unavailable', 'Unavailable')
          )
        }
      }
      running = false
      nextAttempt = Date.now() + (retry ? retryDelay : 30_000)
      retryDelay = retry ? Math.min(300_000, retryDelay * 2) : 30_000
      if (!closed && (pending || retry)) {
        schedule()
      }
    }
    onChange.current = schedule
    schedule()
    return () => {
      closed = true
      onChange.current = null
      clearTimeout(timer)
    }
  }, [account, device, t])
  return null
}

export default function CommanderCheckpointPublisher(): React.JSX.Element | null {
  const [account, setAccount] = useState<CommanderAccount | null>(null)
  const device = useRecordingDevice(account)
  useEffect(() => {
    const profiles = window.api.orcaProfiles
    if (!window.api.commanderMemory || !profiles) {
      return
    }
    let current: symbol | undefined
    function refresh(): void {
      const request = Symbol()
      current = request
      setAccount(null)
      void profiles
        .authStatus()
        .then((status) => {
          if (current === request && status.state === 'connected' && status.cloud) {
            setAccount({
              profileId: status.activeProfileId,
              userId: status.cloud.userId,
              activeOrgId: status.cloud.activeOrgId ?? null
            })
          }
        })
        .catch(() => {})
    }
    refresh()
    const stop = profiles.onAuthStatusChanged(refresh)
    return () => {
      current = undefined
      stop()
    }
  }, [])
  return account && device ? (
    <Publisher key={JSON.stringify(account)} account={account} device={device} />
  ) : null
}

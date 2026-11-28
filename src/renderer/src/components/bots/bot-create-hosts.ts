// The computers New bot can make a bot on, why the others can't yet, and whose Orca account each runs under.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { translateHostDisplayLabel } from '@/runtime/hosts/display/execution-host-label'
import { botHostTarget } from '@/lib/bot-hosts'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeHostConnectionStateForEntry } from '@/runtime/hosts/connections/runtime-host-connection-state'
import { getRendererAppPlatform } from '@/app-shell/platform/renderer-app-platform'
import { useRuntimeStatusByEnvironmentId } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { RuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import { BOTS_CREATE_RUNTIME_CAPABILITY } from '../../../../shared/bot-runtime-capabilities'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { buildExecutionHostRegistry } from '../../../../shared/execution-host/execution-host-registry'
import { getHostDisplayLabelOverrides } from '../../../../shared/execution-host/host-setting-overrides'
import type { OrcaAccountServerStatus } from '../../../../shared/orca-account-server-sign-in'
import { lastVerifiedRuntimeStatus } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import { useBotWslSetup, type BotWslSetup } from './use-bot-wsl-setup'
import { useBotWslWakes } from './use-bot-wsl-wakes'

export type BotCreateHostBlock = 'offline' | 'no-bots' | 'needs-server'

export type BotCreateHost = {
  hostId: ExecutionHostId
  label: string
  /** Why a bot can't be made there now; absent when it can. */
  blocked?: BotCreateHostBlock
  /** The paired server's environment; absent for this computer. */
  environmentId?: string
  /** Its OS, once known. */
  platform?: NodeJS.Platform | null
  /** The host keeps paths the Windows way; absent for this app's own, which knows its own. */
  windows?: boolean
  /** A WSL host main reports `idle` (its server exited with nothing using it, which includes Orca's
   *  idle stop): unreachable now, but picking it wakes it, so it can be picked. */
  sleeping?: boolean
  /** A sleeping host this dialog is waking: picked, but no bot can be made until it answers. */
  waking?: boolean
}

export type BotCreateHostsInput = Pick<AppState, 'runtimeEnvironments' | 'sshTargetLabels'> & {
  wslHostStatuses?: AppState['wslHostStatuses']
  /** WSL hosts this dialog started waking (`useBotWslWakes`). */
  waking?: ReadonlySet<string>
  runtimeStatusByEnvironmentId: RuntimeStatuses
  settings?: Pick<NonNullable<AppState['settings']>, 'hostSettingOverrides'> | null
  t?: Translate
}

/** Configured computers, with creation available locally and on bot-capable paired servers. */
export function botCreateHosts(input: BotCreateHostsInput): BotCreateHost[] {
  const registry = buildExecutionHostRegistry({
    repos: [],
    settings: null,
    hostSource: 'configured-only',
    sshTargetLabels: input.sshTargetLabels,
    runtimeEnvironments: input.runtimeEnvironments,
    hostLabelOverrides: getHostDisplayLabelOverrides(input.settings)
  })
  const labels = new Map(registry.map((host) => [host.id, host.label]))
  const runtimes = (input.runtimeEnvironments ?? []).map((environment): BotCreateHost => {
    const hostId = toRuntimeExecutionHostId(environment.id)
    const base = {
      hostId,
      label: labels.get(hostId) ?? environment.name,
      environmentId: environment.id
    }
    const entry = input.runtimeStatusByEnvironmentId?.get(environment.id)
    const connection = runtimeHostConnectionStateForEntry(entry)
    const status =
      connection === 'connected' || connection === 'workspace-window-closed'
        ? lastVerifiedRuntimeStatus(entry)
        : null
    if (!status) {
      // Main's `idle` sleeps; a failure or a distro it reports stopped stays Can't reach.
      if (input.waking?.has(environment.id)) {
        return { ...base, platform: 'linux', waking: true }
      }
      return input.wslHostStatuses?.[environment.id]?.state === 'idle'
        ? { ...base, platform: 'linux', sleeping: true }
        : { ...base, blocked: 'offline' }
    }
    const platform = status.hostPlatform ?? null
    const windows = platform === 'win32'
    if (!status.capabilities?.includes(BOTS_CREATE_RUNTIME_CAPABILITY)) {
      return { ...base, platform, windows, blocked: 'no-bots' }
    }
    return { ...base, platform, windows }
  })
  const sshOnly = registry
    .filter((host) => host.kind === 'ssh' && !host.mergedIntoHostId)
    .map((host): BotCreateHost => ({
      hostId: host.id,
      label: host.label,
      blocked: 'needs-server'
    }))
  return [
    {
      hostId: LOCAL_EXECUTION_HOST_ID,
      label: translateHostDisplayLabel(registry[0], input.t),
      platform: getRendererAppPlatform()
    },
    ...runtimes,
    ...sshOnly
  ]
}

/** Why a bot can't go on `host`, naming it; `updatable` when the server-update dialog can update it. */
export function botCreateHostBlockedHint(
  host: BotCreateHost,
  updatable: boolean,
  t: Translate = translate
): string | null {
  if (host.blocked === 'offline') {
    return t('bots.new.hostUnreachable', 'Can’t reach {{host}}', { host: host.label })
  }
  if (host.blocked === 'no-bots') {
    return updatable
      ? t('bots.new.hostUpdate', 'Update Orca on {{host}}', { host: host.label })
      : t('bots.new.hostNoBots', 'Orca on {{host}} can’t run bots yet', { host: host.label })
  }
  if (host.blocked === 'needs-server') {
    return t(
      'bots.new.hostNeedsServerHint',
      'Set up an Orca server on {{host}} in Settings → Remote Orca Servers to run bots.',
      {
        host: host.label
      }
    )
  }
  return null
}

const NO_ACCOUNTS: ReadonlyMap<string, string | null> = new Map()

/** Each paired server's Orca account by environment id, read once per open; null when signed out or it can't say. */
function useServerAccounts(
  environmentIds: readonly string[],
  open: boolean
): ReadonlyMap<string, string | null> {
  const [accounts, setAccounts] = useState(NO_ACCOUNTS)
  const asked = useRef(new Set<string>())
  const generation = useRef(0)
  const key = environmentIds.join('\n')
  useEffect(() => {
    if (!open) {
      generation.current += 1
      asked.current = new Set()
      setAccounts(NO_ACCOUNTS)
      return
    }
    const current = generation.current
    for (const environmentId of key ? key.split('\n') : []) {
      if (asked.current.has(environmentId)) {
        continue
      }
      asked.current.add(environmentId)
      const target = botHostTarget(toRuntimeExecutionHostId(environmentId))
      void callRuntimeRpc<OrcaAccountServerStatus>(target, 'orcaAccount.status')
        .then(
          (status) => (status.state === 'signed-in' ? (status.email ?? null) : null),
          // An older server can't say; nothing is shown rather than a guess.
          () => null
        )
        .then((email) => {
          if (generation.current === current) {
            setAccounts((previous) => new Map(previous).set(environmentId, email))
          }
        })
    }
  }, [key, open])
  return accounts
}

export type BotCreateHostChoice = {
  hosts: readonly BotCreateHost[]
  host: BotCreateHost
  setHostId: (hostId: ExecutionHostId) => void
  /** The server's own Orca account, shown when it differs from this app's: the bot runs as it. */
  otherAccount: string | null
  /** `otherAccount` for each listed host whose account was read. */
  otherAccountOf: (hostId: ExecutionHostId) => string | null
  /** The list is shown: read every ready server's account, once. */
  setListing: (listing: boolean) => void
  /** A distro picked under Add host, being set up as a host in place. */
  wslSetup: BotWslSetup
  /** That setup still runs (or failed): no bot can be made until a computer is settled. */
  busy: boolean
  reset: () => void
}

/** Each server's environment by its host id, built once per host list: the Computer list looks one up
 *  per row, so a scan per row would grow with the square of the hosts. */
export function serverEnvironmentIndex(
  hosts: readonly BotCreateHost[]
): ReadonlyMap<ExecutionHostId, string> {
  const index = new Map<ExecutionHostId, string>()
  for (const host of hosts) {
    if (host.environmentId) {
      index.set(host.hostId, host.environmentId)
    }
  }
  return index
}

/** Where a new bot goes: `initialHostId` (this app's own computer) until the owner picks another; `only` limits the list. */
export function useBotCreateHost(
  open: boolean,
  only?: readonly ExecutionHostId[],
  initialHostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID
): BotCreateHostChoice {
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useRuntimeStatusByEnvironmentId()
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const wslHostStatuses = useAppStore((s) => s.wslHostStatuses)
  const settings = useAppStore((s) => s.settings?.hostSettingOverrides)
  const ownEmail = useAppStore((s) =>
    s.orcaProfileAuthStatus?.state === 'connected'
      ? s.orcaProfileAuthStatus.cloud?.email
      : undefined
  )
  const onlyKey = only?.join('\n')
  const t = useTranslate()
  const wakes = useBotWslWakes()
  const { waking, wake } = wakes
  const hosts = useMemo(() => {
    const all = botCreateHosts({
      runtimeEnvironments,
      runtimeStatusByEnvironmentId,
      sshTargetLabels,
      wslHostStatuses,
      waking,
      settings: { hostSettingOverrides: settings },
      t
    })
    const allowed = onlyKey?.split('\n')
    return allowed
      ? all.filter((host) => host.blocked !== 'needs-server' && allowed.includes(host.hostId))
      : all
  }, [
    runtimeEnvironments,
    runtimeStatusByEnvironmentId,
    sshTargetLabels,
    wslHostStatuses,
    waking,
    settings,
    onlyKey,
    t
  ])
  const [hostId, setHostId] = useState<ExecutionHostId>(initialHostId)
  // The pick a WSL setup started from, given back when that setup is cancelled.
  const pickedBeforeSetup = useRef<ExecutionHostId>(initialHostId)
  const pickAddedWslHost = useCallback(
    (environmentId: string) => setHostId(toRuntimeExecutionHostId(environmentId)),
    []
  )
  const restorePick = useCallback(() => setHostId(pickedBeforeSetup.current), [])
  const wslSetup = useBotWslSetup(pickAddedWslHost, restorePick)
  const [listing, setListing] = useState(false)
  // A server unpaired while the dialog is open leaves the first listed computer picked.
  const host =
    hosts.find((entry) => entry.hostId === hostId && entry.blocked !== 'needs-server') ?? hosts[0]
  const asked = hosts
    .filter((entry) => !entry.blocked && (listing || entry.hostId === host.hostId))
    .flatMap((entry) => (entry.environmentId ? [entry.environmentId] : []))
  const accounts = useServerAccounts(asked, open)
  // A sleeping host picked (or picked already, or gone idle while open) is the owner using it: wake it,
  // once; a failed wake waits for a re-pick or a new sleep (`botWslMayAutoWake`).
  const sleepingPick =
    open && host.sleeping && host.environmentId && wakes.mayAutoWake(host.environmentId)
      ? host.environmentId
      : undefined
  useEffect(() => {
    if (sleepingPick) {
      wake(sleepingPick)
    }
  }, [sleepingPick, wake])
  const environmentOf = useMemo(() => serverEnvironmentIndex(hosts), [hosts])
  const otherAccountOf = (id: ExecutionHostId): string | null => {
    const environmentId = environmentOf.get(id)
    const email = environmentId ? accounts.get(environmentId) : null
    return email && email.toLowerCase() !== ownEmail?.toLowerCase() ? email : null
  }
  return {
    hosts,
    host,
    setHostId: (next) => {
      // Another pick leaves a setup to finish on its own; this dialog stops following it.
      wslSetup.finish()
      const environmentId = environmentOf.get(next)
      if (environmentId) {
        wakes.forget(environmentId)
      }
      setHostId(next)
    },
    otherAccount: host.blocked ? null : otherAccountOf(host.hostId),
    otherAccountOf,
    setListing,
    wslSetup: {
      ...wslSetup,
      start: (distro) => {
        pickedBeforeSetup.current = host.hostId
        wslSetup.start(distro)
      }
    },
    busy: wslSetup.state.phase !== 'idle' || Boolean(host.sleeping || host.waking),
    reset: () => {
      wslSetup.finish()
      wakes.reset()
      setHostId(initialHostId)
      setListing(false)
    }
  }
}

/** Whether the server-update dialog can update a server; any other phase would end on "up to date". */
export function useServerUpdatable(): (environmentId: string) => boolean {
  const remoteServerUpdates = useAppStore((s) => s.remoteServerUpdates)
  return (environmentId) => {
    const phase = remoteServerUpdates.get(environmentId)?.phase
    return phase === 'available' || phase === 'failed'
  }
}

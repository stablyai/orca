// Settings › Bots lists computers and Orca accounts rather than one picked host: this app's own
// computer, then each paired server that lists bots, and each Orca account those computers run as,
// once, since Slack, Linear and GitHub belong to an account rather than a computer.
import { useSyncExternalStore } from 'react'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { useRuntimeStatusByEnvironmentId } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { useAppStore } from '@/store'
import {
  readBotHostIds,
  readBotHostState,
  readUpdateNeededBotHosts,
  subscribeToBotChanges
} from '@/lib/bot-catalog-snapshot'
import { botHostHas } from '@/lib/bot-host-status'
import { useBotHostOrcaAccounts } from '@/lib/bot-host-orca-account'
import { BOTS_CONNECTORS_RUNTIME_CAPABILITY } from '../../../../../shared/bot-runtime-capabilities'
import {
  getLocalExecutionHostLabel,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'

export type BotSettingsComputer = {
  hostId: ExecutionHostId
  /** The computer's name: this one's local label, or the paired server's name in Settings. */
  name: string
  local: boolean
  /** `update-needed`: its Orca can't list bots, or can't set up their connectors from here. */
  state: 'live' | 'offline' | 'update-needed'
}

export type BotSettingsAccount = {
  /** Null only for this computer when it isn't signed in to Orca. */
  email: string | null
  /** The computer whose runtime answers for the account's Slack, Linear and GitHub here. */
  hostId: ExecutionHostId
  /** That computer's name when it is a server; null for this one. */
  hostName: string | null
  /** Every computer here on this account, this one first. */
  computers: string[]
  /** Those computers' ids, whose bots all share the account's Slack, Linear and GitHub. */
  hostIds: ExecutionHostId[]
  /** This computer's own account. */
  own: boolean
}

/** Every computer with bots here: this one first, then paired servers in sidebar order. */
export function useBotSettingsComputers(): BotSettingsComputer[] {
  const listed = useSyncExternalStore(subscribeToBotChanges, readBotHostIds)
  const tooOld = useSyncExternalStore(subscribeToBotChanges, readUpdateNeededBotHosts)
  const runtimeStatusByEnvironmentId = useRuntimeStatusByEnvironmentId()
  const names = useAppStore((state) =>
    [...listed, ...tooOld]
      .map((hostId) => selectExecutionHostDisplayLabel(state, hostId))
      .join('\n')
  ).split('\n')
  const servers = [...listed, ...tooOld].flatMap((hostId, index): BotSettingsComputer[] =>
    hostId === LOCAL_EXECUTION_HOST_ID
      ? []
      : [
          {
            hostId,
            name: names[index] || hostId,
            local: false,
            state:
              index >= listed.length ||
              !botHostHas(hostId, BOTS_CONNECTORS_RUNTIME_CAPABILITY, runtimeStatusByEnvironmentId)
                ? 'update-needed'
                : readBotHostState(hostId) === 'offline'
                  ? 'offline'
                  : 'live'
          }
        ]
  )
  return [
    {
      hostId: LOCAL_EXECUTION_HOST_ID,
      name: getLocalExecutionHostLabel(),
      local: true,
      state: 'live'
    },
    ...servers
  ]
}

/**
 * The Orca accounts the computers run as, each once, this computer's first, signed in or not. A
 * server still being read, signed out or lapsed has none: its own group says so and offers the
 * sign-in.
 */
export function useBotSettingsAccounts(
  computers: readonly BotSettingsComputer[]
): BotSettingsAccount[] {
  const servers = computers.filter((computer) => !computer.local && computer.state === 'live')
  const statuses = useBotHostOrcaAccounts(servers.map((computer) => computer.hostId))
  const ownEmail = useAppStore((state) => state.orcaProfileAuthStatus?.cloud?.email ?? null)
  const own = computers.find((computer) => computer.local)
  const accounts = new Map<string | null, BotSettingsAccount>()
  if (own) {
    accounts.set(ownEmail, {
      email: ownEmail,
      hostId: own.hostId,
      hostName: null,
      computers: [own.name],
      hostIds: [own.hostId],
      own: true
    })
  }
  servers.forEach((computer, index) => {
    const status = statuses[index]
    const email = status?.state === 'signed-in' ? status.email : undefined
    if (!email) {
      return
    }
    const known = accounts.get(email)
    if (known) {
      known.computers.push(computer.name)
      known.hostIds.push(computer.hostId)
      return
    }
    accounts.set(email, {
      email,
      hostId: computer.hostId,
      hostName: computer.name,
      computers: [computer.name],
      hostIds: [computer.hostId],
      own: false
    })
  })
  return [...accounts.values()]
}

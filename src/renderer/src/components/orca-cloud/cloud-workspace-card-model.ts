// The calm cloud workspace card (Neil, 5db0b968935f): what each line says, decided without React so
// the copy and the attention order are tested once. The card renders whatever this returns.
import { getIntlLocale } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { CloudDotState } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import type { HostedVmMetrics } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import { ORCA_CLOUD_SANDBOX_SPEC } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import type { CloudSyncView } from '../../../../shared/cloud-sync/cloud-sync-contract'
import { cloudStateDetail } from './cloud-state-copy'
import type { CloudAgentRowSignIn } from '@/lib/orca-cloud/cloud-agent-row-sign-in'

/** "Sleeps in 15 min if idle" while running; "As of 2:31 PM" asleep; else the state's own line. */
export function cloudCardStateDetail(
  args: {
    state: CloudDotState
    restarting: boolean
    idleSleepMinutes: number | undefined
    asOf: number | null
    /** An archived workspace's kept-until date, so the snapshot line names the day. */
    keptUntil?: number | null
  },
  t: Translate
): string | null {
  if (args.restarting) {
    return t('orcaCloudWorkspace.detail.restarting', 'Orca resumes your agents after the restart.')
  }
  if (args.state === 'running') {
    // The control plane's idle timer; older control planes omit it (their timer is 15 min).
    return t('orcaCloudWorkspace.card.sleepsIn', 'Sleeps in {{count}} min if idle', {
      count: args.idleSleepMinutes ?? 15,
      defaultValue_one: 'Sleeps in {{count}} min if idle'
    })
  }
  if (args.state === 'sleeping') {
    return args.asOf === null
      ? null
      : t('orcaCloudWorkspace.card.asOf', 'As of {{time}}', {
          time: new Intl.DateTimeFormat(getIntlLocale(), { timeStyle: 'short' }).format(args.asOf)
        })
  }
  return cloudStateDetail(args.state, t, args.keptUntil)
}

/** "CPU 13% · Memory 1.8 / 16 GB": the plan's memory, never the VM's own report of it. */
export function cloudCardUsageLine(
  metrics: Pick<HostedVmMetrics, 'cpuPercent' | 'memUsedBytes'>,
  t: Translate
): string {
  const usedGb = metrics.memUsedBytes / 1e9
  const used = new Intl.NumberFormat(getIntlLocale(), {
    maximumFractionDigits: usedGb >= 10 ? 0 : 1
  }).format(usedGb)
  return t('orcaCloudWorkspace.card.usage', 'CPU {{cpu}}% · Memory {{used}} / {{total}} GB', {
    cpu: Math.round(metrics.cpuPercent),
    used,
    total: ORCA_CLOUD_SANDBOX_SPEC.memoryGb
  })
}

export type CloudCardAttention =
  | { kind: 'agentNotSetUp'; agent: string; tabId: string }
  | { kind: 'agentExpired'; agent: string; tabId: string }
  /** GIT-SETUP: the teammates' git identities couldn't be installed; commits and pushes are off. */
  | { kind: 'gitSetupOff' }
  | { kind: 'secretsMissing'; count: number }

const URGENCY: Record<CloudCardAttention['kind'], number> = {
  // An agent that can't start blocks the work the workspace was made for.
  agentNotSetUp: 0,
  agentExpired: 1,
  // Below an agent that can't start, above missing secrets (design-squad).
  gitSetupOff: 2,
  secretsMissing: 3
}

/** At most one row: the most urgent thing that needs doing; null when all is well. */
export function mostUrgentAttention(
  items: readonly (CloudCardAttention | null)[]
): CloudCardAttention | null {
  let best: CloudCardAttention | null = null
  for (const item of items) {
    if (item && (!best || URGENCY[item.kind] < URGENCY[best.kind])) {
      best = item
    }
  }
  return best
}

export function cloudCardAttentionLabel(item: CloudCardAttention, t: Translate): string {
  switch (item.kind) {
    case 'agentNotSetUp':
      return t('orcaCloud.agentHold.notSetUp', '{{agent}} isn’t set up for Orca Cloud', {
        agent: item.agent
      })
    case 'agentExpired':
      return t('orcaCloud.agentHold.expired', '{{agent}} sign-in expired', { agent: item.agent })
    case 'gitSetupOff':
      return t('orcaCloudWorkspace.card.gitSetupOff', 'Commits and pushes are off')
    case 'secretsMissing':
      return t('cloudSecretsAsk.missing', '{{count}} secrets missing', {
        count: item.count,
        defaultValue_one: '{{count}} secret missing'
      })
  }
}

/** The "On this computer ›" row's short status. */
export function cloudCardOnComputerStatus(view: CloudSyncView | null, t: Translate): string {
  if (!view || (!view.choice.context && !view.choice.mirror)) {
    return t('orcaCloudWorkspace.card.syncOff', 'Off')
  }
  if (view.phase === 'error') {
    return t('orcaCloudWorkspace.card.syncError', 'Couldn’t sync')
  }
  if (view.phase === 'starting' || view.phase === 'copying') {
    return t('orcaCloudSync.syncing', 'Syncing…')
  }
  if (view.choice.mirror && view.choice.context) {
    return t('orcaCloudWorkspace.card.mirroringAndContext', 'Mirroring · .context synced')
  }
  return view.choice.mirror
    ? t('orcaCloudWorkspace.card.mirroring', 'Mirroring')
    : t('orcaCloudWorkspace.card.contextSynced', '.context synced')
}

export type CloudCardPrimary = 'sleep' | 'wake' | 'restart' | 'unarchive' | null

/** The footer's one visible action for the state; everything else lives under ⋯. */
export function cloudCardPrimary(state: CloudDotState, restarting: boolean): CloudCardPrimary {
  if (restarting) {
    return 'restart'
  }
  switch (state) {
    case 'running':
      return 'sleep'
    case 'sleeping':
      return 'wake'
    case 'archived':
      return 'unarchive'
    // Not responding or failed to start: Restart is the fix, so it is the one action shown.
    case 'unresponsive':
    case 'failed':
    case 'wakeFailed':
      return 'restart'
    case 'waking':
    case 'starting':
    case 'unknown':
      return null
  }
}

/**
 * Of a workspace's agent panes, the sign-in state the card should name: "isn't set up" before
 * "sign-in expired" (the same order as the attention row), the first such pane within each.
 */
export function pickWorkspaceAgentSignIn<P>(
  panes: readonly P[],
  signInFor: (pane: P) => CloudAgentRowSignIn | null
): { pane: P; signIn: CloudAgentRowSignIn } | null {
  let expired: { pane: P; signIn: CloudAgentRowSignIn } | null = null
  for (const pane of panes) {
    const signIn = signInFor(pane)
    if (signIn === 'needsSignIn') {
      return { pane, signIn }
    }
    if (signIn === 'expired' && !expired) {
      expired = { pane, signIn }
    }
  }
  return expired
}

/** The attention item for a picked sign-in state. */
export function signInAttention(
  picked: { signIn: CloudAgentRowSignIn; tabId: string; agentName: string } | null
): CloudCardAttention | null {
  if (!picked) {
    return null
  }
  return picked.signIn === 'expired'
    ? { kind: 'agentExpired', agent: picked.agentName, tabId: picked.tabId }
    : { kind: 'agentNotSetUp', agent: picked.agentName, tabId: picked.tabId }
}

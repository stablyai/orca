import { useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
import { useShallow } from 'zustand/react/shallow'
import {
  CLAUDE_STATS_CACHE_UNAVAILABLE_REASONS,
  type ClaudeStatsCacheHome,
  type ClaudeStatsCacheUnavailableReason
} from '../../../../shared/claude-usage-types'
import { useAppStore } from '../../store'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { isWslHostRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { runtimeHostConnectionStateForEntry } from '../../runtime/runtime-host-connection-state'
import { formatDayKey, formatTokens } from './usage-formatters'
import { translate } from '@/i18n/i18n'

const UNAVAILABLE_REASON_LABELS: Record<ClaudeStatsCacheUnavailableReason, string> = {
  get 'unsupported-version'() {
    return translate(
      'auto.components.stats.ClaudeStatsCacheSection.reasonUnsupportedVersion',
      'Unsupported /stats file version'
    )
  },
  get invalid() {
    return translate(
      'auto.components.stats.ClaudeStatsCacheSection.reasonInvalid',
      'Unrecognized /stats file'
    )
  },
  get 'too-large'() {
    return translate(
      'auto.components.stats.ClaudeStatsCacheSection.reasonTooLarge',
      '/stats file is too large to read'
    )
  },
  get unreadable() {
    return translate(
      'auto.components.stats.ClaudeStatsCacheSection.reasonUnreadable',
      'Could not read /stats file'
    )
  }
}

const REMOTE_STATS_CACHE_TIMEOUT_MS = 15_000

/** hostName null is this machine. */
export type ClaudeStatsCacheRow = ClaudeStatsCacheHome & { hostName: string | null; key: string }

type StatsCacheHost = { environmentId: string; name: string }

function homeSummaryText(home: ClaudeStatsCacheRow, showHomeLabel: boolean): string {
  const where = home.hostName
    ? translate('auto.components.stats.ClaudeStatsCacheSection.hostHome', '{{host}} · {{home}}', {
        host: home.hostName,
        home: home.label
      })
    : home.label
  if (home.status === 'unavailable') {
    const reason = UNAVAILABLE_REASON_LABELS[home.reason]
    return showHomeLabel
      ? translate(
          'auto.components.stats.ClaudeStatsCacheSection.homeUnavailable',
          '{{where}} · {{reason}}',
          { where, reason }
        )
      : reason
  }
  const tokens = formatTokens(home.totalTokens)
  const date = formatDayKey(home.lastComputedDate, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
  return showHomeLabel
    ? translate(
        'auto.components.stats.ClaudeStatsCacheSection.lifetimeTokensAtHome',
        '{{tokens}} lifetime tokens · {{where}} · as of {{date}}',
        { tokens, where, date }
      )
    : translate(
        'auto.components.stats.ClaudeStatsCacheSection.lifetimeTokens',
        '{{tokens}} lifetime tokens · as of {{date}}',
        { tokens, date }
      )
}

export function ClaudeStatsCacheSection({
  homes
}: {
  homes: ClaudeStatsCacheRow[]
}): React.JSX.Element | null {
  if (homes.length === 0) {
    return null
  }
  const showHomeLabel = homes.length > 1 || homes.some((home) => home.hostName !== null)
  return (
    // Each entry leads with a divider the clip hides at line starts; -ml-[11px] = pl-2.5 + border.
    <span className="-my-1 min-w-0 overflow-hidden py-1">
      <span className="-ml-[11px] flex flex-wrap items-center gap-y-1">
        {homes.map((home) => (
          <span
            key={home.key}
            className="mr-2.5 border-l border-border pl-2.5 text-xs leading-4 text-muted-foreground"
          >
            {homeSummaryText(home, showHomeLabel)}
          </span>
        ))}
      </span>
    </span>
  )
}

// Remote servers may run other Orca versions, so validate each row and drop only the bad ones.
const statsCacheHomeSchema: z.ZodType<ClaudeStatsCacheHome> = z.discriminatedUnion('status', [
  z.object({
    configHome: z.string(),
    label: z.string(),
    status: z.literal('ok'),
    totalTokens: z.number().nonnegative(),
    lastComputedDate: z.iso.date()
  }),
  z.object({
    configHome: z.string(),
    label: z.string(),
    status: z.literal('unavailable'),
    reason: z.enum(CLAUDE_STATS_CACHE_UNAVAILABLE_REASONS).catch('unreadable')
  })
])

function parseStatsCacheHomes(value: unknown): ClaudeStatsCacheHome[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((home: unknown) => {
    const parsed = statsCacheHomeSchema.safeParse(home)
    return parsed.success ? [parsed.data] : []
  })
}

async function readHostStatsCaches(
  host: StatsCacheHost | null,
  signal: AbortSignal
): Promise<ClaudeStatsCacheRow[]> {
  try {
    const result = host
      ? await callRuntimeRpc<unknown>(
          { kind: 'environment', environmentId: host.environmentId },
          'stats.claudeStatsCache',
          undefined,
          { timeoutMs: REMOTE_STATS_CACHE_TIMEOUT_MS, signal }
        )
      : await window.api.claudeUsage.getStatsCache()
    // Why: web clients resolve undefined.
    return parseStatsCacheHomes(result).map((home) => ({
      ...home,
      hostName: host?.name ?? null,
      key: `${host?.environmentId ?? 'local'}\0${home.configHome}`
    }))
  } catch {
    return []
  }
}

/** Connected non-WSL hosts; this machine already reads running distros. */
function useConnectedStatsCacheHosts(): StatsCacheHost[] {
  // Flat [id, name, ...] so useShallow ignores unrelated catalog and status writes.
  const idNamePairs = useAppStore(
    useShallow((state) =>
      state.runtimeEnvironments.flatMap((environment) => {
        if (isWslHostRuntimeEnvironment(environment)) {
          return []
        }
        // runtime-unavailable hosts would only time out.
        const connection = runtimeHostConnectionStateForEntry(
          state.runtimeStatusByEnvironmentId.get(environment.id)
        )
        return connection === 'connected' || connection === 'workspace-window-closed'
          ? [environment.id, environment.name]
          : []
      })
    )
  )
  return useMemo(() => {
    const hosts: StatsCacheHost[] = []
    for (let index = 0; index < idNamePairs.length; index += 2) {
      hosts.push({ environmentId: idNamePairs[index], name: idNamePairs[index + 1] })
    }
    return hosts
  }, [idNamePairs])
}

/** Re-reads every connected host's /stats cache whenever refreshKey changes; null skips while tracking is off. */
export function useClaudeStatsCache(refreshKey: string | null): ClaudeStatsCacheRow[] {
  // Keyed by environmentId, null for this machine, so each host renders as soon as it answers.
  const [rowsByHost, setRowsByHost] = useState<ReadonlyMap<string | null, ClaudeStatsCacheRow[]>>(
    () => new Map()
  )
  const hosts = useConnectedStatsCacheHosts()
  useEffect(() => {
    if (refreshKey === null) {
      setRowsByHost(new Map())
      return
    }
    const hostKeys = new Set([null, ...hosts.map((host) => host.environmentId)])
    setRowsByHost((previous) => new Map([...previous].filter(([key]) => hostKeys.has(key))))
    const controller = new AbortController()
    for (const host of [null, ...hosts]) {
      void readHostStatsCaches(host, controller.signal).then((rows) => {
        if (!controller.signal.aborted) {
          setRowsByHost((previous) => new Map(previous).set(host?.environmentId ?? null, rows))
        }
      })
    }
    return () => controller.abort()
  }, [refreshKey, hosts])
  return useMemo(
    () => [null, ...hosts].flatMap((host) => rowsByHost.get(host?.environmentId ?? null) ?? []),
    [rowsByHost, hosts]
  )
}

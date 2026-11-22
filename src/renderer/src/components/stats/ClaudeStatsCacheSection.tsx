import { useEffect, useState } from 'react'
import { z } from 'zod'
import {
  CLAUDE_STATS_CACHE_UNAVAILABLE_REASONS,
  type ClaudeStatsCacheHome,
  type ClaudeStatsCacheUnavailableReason
} from '../../../../shared/agent-usage/analytics/claude-usage-types'
import { useAppStore } from '../../store'
import { usageApiForHost } from '../../store/slices/usage/usage-host'
import { formatDayKey, formatTokens } from './usage-formatters'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'

function unavailableReasonLabel(reason: ClaudeStatsCacheUnavailableReason, t: Translate): string {
  switch (reason) {
    case 'unsupported-version':
      return t(
        'auto.components.stats.ClaudeStatsCacheSection.reasonUnsupportedVersion',
        'Unsupported /stats file version'
      )
    case 'invalid':
      return t(
        'auto.components.stats.ClaudeStatsCacheSection.reasonInvalid',
        'Unrecognized /stats file'
      )
    case 'too-large':
      return t(
        'auto.components.stats.ClaudeStatsCacheSection.reasonTooLarge',
        '/stats file is too large to read'
      )
    case 'unreadable':
      return t(
        'auto.components.stats.ClaudeStatsCacheSection.reasonUnreadable',
        'Could not read /stats file'
      )
  }
}

function homeSummaryText(
  home: ClaudeStatsCacheHome,
  showHomeLabel: boolean,
  t: Translate,
  intlLocale: string
): string {
  const where = home.label
  if (home.status === 'unavailable') {
    const reason = unavailableReasonLabel(home.reason, t)
    return showHomeLabel
      ? t(
          'auto.components.stats.ClaudeStatsCacheSection.homeUnavailable',
          '{{where}} · {{reason}}',
          {
            where,
            reason
          }
        )
      : reason
  }
  const tokens = formatTokens(home.totalTokens, intlLocale)
  const date = formatDayKey(
    home.lastComputedDate,
    { year: 'numeric', month: 'short', day: 'numeric' },
    intlLocale
  )
  return showHomeLabel
    ? t(
        'auto.components.stats.ClaudeStatsCacheSection.lifetimeTokensAtHome',
        '{{tokens}} lifetime tokens · {{where}} · as of {{date}}',
        { tokens, where, date }
      )
    : t(
        'auto.components.stats.ClaudeStatsCacheSection.lifetimeTokens',
        '{{tokens}} lifetime tokens · as of {{date}}',
        { tokens, date }
      )
}

export function ClaudeStatsCacheSection({
  homes
}: {
  homes: ClaudeStatsCacheHome[]
}): React.JSX.Element | null {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  if (homes.length === 0) {
    return null
  }
  const showHomeLabel = homes.length > 1
  return (
    // Each entry leads with a divider the clip hides at line starts; -ml-[11px] = pl-2.5 + border.
    <span className="-my-1 min-w-0 overflow-hidden py-1">
      <span className="-ml-[11px] flex flex-wrap items-center gap-y-1">
        {homes.map((home) => (
          <span
            key={home.configHome}
            className="mr-2.5 border-l border-border pl-2.5 text-xs leading-4 text-muted-foreground"
          >
            {homeSummaryText(home, showHomeLabel, t, intlLocale)}
          </span>
        ))}
      </span>
    </span>
  )
}

// Remote hosts may run other Orca versions, so validate each row and drop only the bad ones.
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

/** Re-reads the shown host's /stats caches whenever refreshKey changes; null clears them. */
export function useClaudeStatsCache(refreshKey: string | null): ClaudeStatsCacheHome[] {
  const host = useAppStore((state) => state.statsHost)
  const [homes, setHomes] = useState<ClaudeStatsCacheHome[]>([])
  useEffect(() => {
    if (refreshKey === null) {
      setHomes([])
      return
    }
    let current = true
    // Older hosts reject the unknown action; they simply show no line.
    void usageApiForHost(host, 'claudeUsage')
      .getStatsCache()
      .then(parseStatsCacheHomes, () => [])
      .then((rows) => {
        if (current) {
          setHomes(rows)
        }
      })
    return () => {
      current = false
    }
  }, [host, refreshKey])
  return homes
}

import type {
  ClaudeUsageDailyPoint,
  ClaudeUsageSummary
} from '../../../../shared/agent-usage/analytics/claude-usage-types'
import type {
  CodexUsageDailyPoint,
  CodexUsageSummary
} from '../../../../shared/agent-usage/analytics/codex-usage-types'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { GitHubIcon } from '@/components/icons/GitHubIcon'
import { ZOTZ_RELEASE_REPO } from '../../../../shared/zotz/zotz-app-identity'

export type ClaudeShareData = {
  provider: 'claude'
  summary: ClaudeUsageSummary
  daily: ClaudeUsageDailyPoint[]
}

export type CodexShareData = {
  provider: 'codex'
  summary: CodexUsageSummary
  daily: CodexUsageDailyPoint[]
}

export function formatTokens(value: number, intlLocale: string = getIntlLocale()): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`
  }
  return value.toLocaleString(intlLocale)
}

export function formatCost(value: number | null): string {
  if (value === null) {
    return 'n/a'
  }
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

export function formatDateRange(range: string, intlLocale: string = getIntlLocale()): string {
  const now = new Date()
  const end = now.toLocaleDateString(intlLocale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
  if (range === 'all') {
    return `Through ${end}`
  }
  const days = Number.parseInt(range)
  if (Number.isNaN(days)) {
    return end
  }
  const start = new Date(now.getTime() - days * 86_400_000)
  const startStr = start.toLocaleDateString(intlLocale, { month: 'short', day: 'numeric' })
  return `${startStr} – ${end}`
}

export const RANGE_LABELS: Record<string, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  all: 'All time'
}

export function getDailyTotal(entry: ClaudeUsageDailyPoint | CodexUsageDailyPoint): number {
  if ('cacheReadTokens' in entry) {
    return entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens
  }
  return entry.totalTokens
}

export type DailySegment = { key: string; value: number; color: string }

export function getDailySegments(
  entry: ClaudeUsageDailyPoint | CodexUsageDailyPoint
): DailySegment[] {
  // Preserve chart segment order in the bottom-aligned stack.
  if ('cacheReadTokens' in entry) {
    return [
      { key: 'cache-write', value: entry.cacheWriteTokens, color: 'rgba(217, 70, 239, 0.7)' },
      { key: 'cache-read', value: entry.cacheReadTokens, color: 'rgba(251, 191, 36, 0.7)' },
      { key: 'output', value: entry.outputTokens, color: 'rgba(52, 211, 153, 0.8)' },
      { key: 'input', value: entry.inputTokens, color: 'rgba(56, 189, 248, 0.8)' }
    ]
  }
  return [
    { key: 'input', value: entry.inputTokens, color: 'rgba(56, 189, 248, 0.8)' },
    { key: 'output', value: entry.outputTokens, color: 'rgba(52, 211, 153, 0.8)' },
    { key: 'cached', value: entry.cachedInputTokens, color: 'rgba(251, 191, 36, 0.7)' },
    { key: 'reasoning', value: entry.reasoningOutputTokens, color: 'rgba(217, 70, 239, 0.7)' }
  ]
}

export function getLegendItems(provider: 'claude' | 'codex', t: Translate = translate) {
  if (provider === 'claude') {
    return [
      {
        label: t('auto.components.stats.share.card.utils.c2d7b23d57', 'Input'),
        color: 'rgba(56, 189, 248, 0.8)'
      },
      {
        label: t('auto.components.stats.share.card.utils.33d38e2177', 'Output'),
        color: 'rgba(52, 211, 153, 0.8)'
      },
      {
        label: t('auto.components.stats.share.card.utils.cc28cb965e', 'Cache read'),
        color: 'rgba(251, 191, 36, 0.7)'
      },
      {
        label: t('auto.components.stats.share.card.utils.9d166247ee', 'Cache write'),
        color: 'rgba(217, 70, 239, 0.7)'
      }
    ]
  }
  return [
    {
      label: t('auto.components.stats.share.card.utils.c2d7b23d57', 'Input'),
      color: 'rgba(56, 189, 248, 0.8)'
    },
    {
      label: t('auto.components.stats.share.card.utils.33d38e2177', 'Output'),
      color: 'rgba(52, 211, 153, 0.8)'
    },
    {
      label: t('auto.components.stats.share.card.utils.4ee864629a', 'Cached input'),
      color: 'rgba(251, 191, 36, 0.7)'
    },
    {
      label: t('auto.components.stats.share.card.utils.7080aeaebb', 'Reasoning'),
      color: 'rgba(217, 70, 239, 0.7)'
    }
  ]
}

export function OrcaLogo(): React.JSX.Element {
  // Zotz bat mark; same path as resources/logo.svg.
  return (
    <svg
      width={26}
      height={14}
      viewBox="2 15 60 32"
      xmlns="http://www.w3.org/2000/svg"
      style={{ opacity: 0.9, verticalAlign: 'middle' }}
    >
      <path
        fill="#ffffff"
        d="M32 24L35 22L37 15L39.5 24C46 22 55 18 62 20C59 26 58 31 58 37Q53 31 48 36Q43 32 39 40Q35 40 32 47Q29 40 25 40Q21 32 16 36Q11 31 6 37C6 31 5 26 2 20C9 18 18 22 24.5 24L27 15L29 22Z"
      />
    </svg>
  )
}

export function BackgroundGlows(): React.JSX.Element {
  return (
    <>
      <div
        style={{
          position: 'absolute',
          top: '-60%',
          right: '-20%',
          width: 300,
          height: 300,
          background: 'radial-gradient(circle, rgba(20, 71, 230, 0.08) 0%, transparent 70%)',
          pointerEvents: 'none'
        }}
      />
      <div
        style={{
          position: 'absolute',
          bottom: '-40%',
          left: '-10%',
          width: 250,
          height: 250,
          background: 'radial-gradient(circle, rgba(139, 92, 246, 0.05) 0%, transparent 70%)',
          pointerEvents: 'none'
        }}
      />
    </>
  )
}

export function CardFooter(props: {
  summary: { inputTokens: number; outputTokens: number }
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  return (
    <div
      style={{
        display: 'table',
        width: '100%',
        marginTop: 16,
        paddingTop: 12,
        borderTop: '1px solid rgba(255, 255, 255, 0.05)',
        position: 'relative',
        zIndex: 1
      }}
    >
      <div style={{ display: 'table-cell', verticalAlign: 'middle' }}>
        <span style={{ fontSize: 12, color: '#888' }}>
          <strong style={{ color: '#ccc' }}>
            {formatTokens(props.summary.inputTokens, intlLocale)}
          </strong>{' '}
          {t('auto.components.stats.share.card.utils.5d66fdd7c2', 'input')}
        </span>
        <span style={{ fontSize: 12, color: '#888', marginLeft: 16 }}>
          <strong style={{ color: '#ccc' }}>
            {formatTokens(props.summary.outputTokens, intlLocale)}
          </strong>{' '}
          {t('auto.components.stats.share.card.utils.d864fc5f98', 'output')}
        </span>
      </div>
      <div style={{ display: 'table-cell', verticalAlign: 'middle', textAlign: 'right' }}>
        <span style={{ display: 'inline-block', verticalAlign: 'middle' }}>
          <GitHubIcon
            width={13}
            height={13}
            fill="#888"
            style={{ opacity: 0.6, verticalAlign: 'middle' }}
          />
        </span>
        <span
          style={{
            fontSize: 11,
            color: '#888',
            letterSpacing: 0.2,
            verticalAlign: 'middle',
            marginLeft: 5
          }}
        >
          {`github.com/${ZOTZ_RELEASE_REPO}`}
        </span>
      </div>
    </div>
  )
}

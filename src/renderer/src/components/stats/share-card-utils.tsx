import type {
  ClaudeUsageDailyPoint,
  ClaudeUsageSummary
} from '../../../../shared/claude-usage-types'
import type { CodexUsageDailyPoint, CodexUsageSummary } from '../../../../shared/codex-usage-types'

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

export function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`
  }
  return value.toLocaleString()
}

export function formatCost(value: number | null): string {
  if (value === null) {
    return 'n/a'
  }
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

export function formatDateRange(range: string): string {
  const now = new Date()
  const end = now.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  if (range === 'all') {
    return `Through ${end}`
  }
  const days = parseInt(range)
  if (Number.isNaN(days)) {
    return end
  }
  const start = new Date(now.getTime() - days * 86_400_000)
  const startStr = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
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
  // Why: segment order matches the original charts exactly (top-to-bottom).
  // Segments render as stacked block divs in a table cell with vertical-align: bottom.
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

export function getLegendItems(provider: 'claude' | 'codex') {
  if (provider === 'claude') {
    return [
      { label: 'Input', color: 'rgba(56, 189, 248, 0.8)' },
      { label: 'Output', color: 'rgba(52, 211, 153, 0.8)' },
      { label: 'Cache read', color: 'rgba(251, 191, 36, 0.7)' },
      { label: 'Cache write', color: 'rgba(217, 70, 239, 0.7)' }
    ]
  }
  return [
    { label: 'Input', color: 'rgba(56, 189, 248, 0.8)' },
    { label: 'Output', color: 'rgba(52, 211, 153, 0.8)' },
    { label: 'Cached input', color: 'rgba(251, 191, 36, 0.7)' },
    { label: 'Reasoning', color: 'rgba(217, 70, 239, 0.7)' }
  ]
}

export function OrcaLogo(): React.JSX.Element {
  return (
    <svg
      width={26}
      height={26}
      viewBox="0 0 318.60232 202.66667"
      xmlns="http://www.w3.org/2000/svg"
      style={{ opacity: 0.9, verticalAlign: 'middle' }}
    >
      <g style={{ display: 'inline' }} transform="translate(-6.6666669,-70.666669)">
        <path
          style={{ display: 'inline', fill: '#ffffff' }}
          d="m 177.81311,248.33334 c 23.82304,-41.29793 40.54045,-66.84626 49.51207,-75.66667 6.81685,-6.70196 10.07373,-8.7374 20.07265,-12.54475 34.57822,-13.16655 61.04674,-26.78733 72.37222,-37.24295 9.62924,-8.88966 9.34286,-9.01142 -23.43671,-9.964 -35.71756,-1.03796 -43.72989,0.42119 -62.17546,11.323 -16.72118,9.88265 -34.20103,30.11225 -42.74704,49.47157 -2.57353,5.82985 -14.81294,44.3056 -27.96399,87.90747 -2.86036,9.48343 -3.02466,11.71633 -0.86213,11.71633 0.44382,0 7.29659,-11.25 15.22839,-25 z m -65.14644,-8.32267 C 120,239.3326 130.5,237.50979 136,235.95998 c 5.5,-1.5498 12.25,-3.13783 15,-3.52895 2.75,-0.39111 5,-0.95485 5,-1.25275 0,-0.29789 2.15135,-7.58487 4.78078,-16.19328 8.49209,-27.80201 12.21334,-40.41629 21.13747,-71.65166 4.81891,-16.86667 11.23502,-39.185 14.25802,-49.596301 5.12803,-17.66103 5.74763,-23.07037 2.64253,-23.07037 -1.84887,0 -4.07048,6.908293 -16.72243,52.000001 -21.78975,77.65896 -20.80806,74.74393 -26.84794,79.72251 -7.5925,6.25838 -25.03916,14.82524 -36.10856,17.73044 -17.0947,4.48656 -33.410599,3.86724 -53.116765,-2.01622 -18.569242,-5.54403 -23.142662,-5.80284 -33.639754,-1.9037 -5.875424,2.18242 -9.864152,5.04363 -16.716684,11.99127 -4.95,5.0187 -9.0000001,10.02884 -9.0000001,11.13364 0,1.75174 5.9276921,2.00299 46.3333351,1.96383 25.483334,-0.0247 52.333338,-0.59969 59.666668,-1.27777 z M 252.69513,104.63708 c 12.18267,-3.48651 15.77304,-7.895503 9.63821,-11.835773 -10.19296,-6.546726 -36.19849,-1.77301 -41.19436,7.561863 -1.2556,2.3461 -0.98698,3.2037 1.68353,5.375 2.69471,2.19098 4.59991,2.47691 12.53928,1.88189 5.14899,-0.3859 12.94899,-1.72824 17.33334,-2.98298 z"
        />
      </g>
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
          <strong style={{ color: '#ccc' }}>{formatTokens(props.summary.inputTokens)}</strong> input
        </span>
        <span style={{ fontSize: 12, color: '#888', marginLeft: 16 }}>
          <strong style={{ color: '#ccc' }}>{formatTokens(props.summary.outputTokens)}</strong>{' '}
          output
        </span>
      </div>
      <div style={{ display: 'table-cell', verticalAlign: 'middle', textAlign: 'right' }}>
        <span style={{ display: 'inline-block', verticalAlign: 'middle' }}>
          <GitHubIcon />
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
          github.com/stablyai/orca
        </span>
      </div>
    </div>
  )
}

function GitHubIcon(): React.JSX.Element {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 16 16"
      fill="#888"
      style={{ opacity: 0.6, verticalAlign: 'middle' }}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

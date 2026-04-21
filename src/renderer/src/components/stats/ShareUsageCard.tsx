import { forwardRef } from 'react'
import type {
  ClaudeUsageDailyPoint,
  ClaudeUsageSummary
} from '../../../../shared/claude-usage-types'
import type { CodexUsageDailyPoint, CodexUsageSummary } from '../../../../shared/codex-usage-types'

type ClaudeShareData = {
  provider: 'claude'
  summary: ClaudeUsageSummary
  daily: ClaudeUsageDailyPoint[]
}

type CodexShareData = {
  provider: 'codex'
  summary: CodexUsageSummary
  daily: CodexUsageDailyPoint[]
}

export type ShareUsageCardProps = (ClaudeShareData | CodexShareData) & {
  range: string
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`
  }
  return value.toLocaleString()
}

function formatCost(value: number | null): string {
  if (value === null) {
    return 'n/a'
  }
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

function formatDateRange(range: string): string {
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

const RANGE_LABELS: Record<string, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  all: 'All time'
}

function getDailyTotal(entry: ClaudeUsageDailyPoint | CodexUsageDailyPoint): number {
  if ('cacheReadTokens' in entry) {
    return entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens
  }
  return entry.totalTokens
}

function getDailySegments(
  entry: ClaudeUsageDailyPoint | CodexUsageDailyPoint
): { key: string; value: number; color: string }[] {
  // Why: segment order matches the original charts exactly (top-to-bottom).
  // Segments render as stacked block divs in a table cell with vertical-align: bottom.
  if ('cacheReadTokens' in entry) {
    // ClaudeUsageDailyChart: cache-write, cache-read, output, input
    return [
      { key: 'cache-write', value: entry.cacheWriteTokens, color: 'rgba(217, 70, 239, 0.7)' },
      { key: 'cache-read', value: entry.cacheReadTokens, color: 'rgba(251, 191, 36, 0.7)' },
      { key: 'output', value: entry.outputTokens, color: 'rgba(52, 211, 153, 0.8)' },
      { key: 'input', value: entry.inputTokens, color: 'rgba(56, 189, 248, 0.8)' }
    ]
  }
  // CodexUsageDailyChart: input, output, cached-input, reasoning
  return [
    { key: 'input', value: entry.inputTokens, color: 'rgba(56, 189, 248, 0.8)' },
    { key: 'output', value: entry.outputTokens, color: 'rgba(52, 211, 153, 0.8)' },
    { key: 'cached', value: entry.cachedInputTokens, color: 'rgba(251, 191, 36, 0.7)' },
    { key: 'reasoning', value: entry.reasoningOutputTokens, color: 'rgba(217, 70, 239, 0.7)' }
  ]
}

function getLegendItems(provider: 'claude' | 'codex') {
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

// Why: html2canvas cannot resolve flexbox gap or align-items reliably.
// All layout uses explicit margins, padding, vertical-align, and table display
// instead of flexbox/grid to ensure pixel-perfect capture.
export const ShareUsageCard = forwardRef<HTMLDivElement, ShareUsageCardProps>(
  function ShareUsageCard(props, ref) {
    const { provider, summary, daily, range } = props
    const slicedDaily = daily.slice(-10)

    const totalTokens =
      provider === 'claude'
        ? summary.inputTokens + summary.outputTokens
        : (summary as CodexUsageSummary).totalTokens

    const topModel =
      provider === 'claude'
        ? ((summary as ClaudeUsageSummary).topModel ?? 'n/a')
        : ((summary as CodexUsageSummary).topModel ?? 'n/a')

    const sessions =
      provider === 'claude'
        ? (summary as ClaudeUsageSummary).sessions
        : (summary as CodexUsageSummary).sessions

    const turnsOrEvents =
      provider === 'claude'
        ? { label: 'turns', count: (summary as ClaudeUsageSummary).turns }
        : { label: 'events', count: (summary as CodexUsageSummary).events }

    const providerLabel = provider === 'claude' ? 'Claude' : 'Codex'

    return (
      <div
        ref={ref}
        style={{
          width: 480,
          padding: '28px 28px 24px',
          background: 'linear-gradient(145deg, #111111 0%, #0a0a0a 50%, #0d0d1a 100%)',
          borderRadius: 16,
          border: '1px solid rgba(255, 255, 255, 0.08)',
          color: '#fafafa',
          fontFamily: "'Helvetica Neue', Arial, sans-serif",
          WebkitFontSmoothing: 'antialiased',
          position: 'relative',
          overflow: 'hidden'
        }}
      >
        {/* Background glow accents */}
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

        {/* Header — use table layout for reliable vertical centering */}
        <div
          style={{
            display: 'table',
            width: '100%',
            marginBottom: 6,
            position: 'relative',
            zIndex: 1
          }}
        >
          <div style={{ display: 'table-cell', verticalAlign: 'middle' }}>
            <div style={{ display: 'inline-block', verticalAlign: 'middle' }}>
              <OrcaLogo />
            </div>
            <div style={{ display: 'inline-block', verticalAlign: 'middle', marginLeft: 10 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#fafafa', lineHeight: 1.2 }}>
                Orca IDE
              </div>
              <div style={{ fontSize: 10, color: '#555', letterSpacing: 0.3 }}>
                {providerLabel} Usage
              </div>
            </div>
          </div>
          <div style={{ display: 'table-cell', verticalAlign: 'middle', textAlign: 'right' }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: '#a1a1a1',
                background: 'rgba(255, 255, 255, 0.06)',
                padding: '3px 8px',
                borderRadius: 6,
                letterSpacing: 0.3
              }}
            >
              {RANGE_LABELS[range] ?? range}
            </span>
          </div>
        </div>

        {/* Date range */}
        <div
          style={{ fontSize: 11, color: '#555', position: 'relative', zIndex: 1, marginBottom: 16 }}
        >
          {formatDateRange(range)}
        </div>

        {/* Stats grid — 3 inline-blocks at exactly 1/3 width minus gaps */}
        <div style={{ position: 'relative', zIndex: 1, marginBottom: 20 }}>
          {[
            {
              value: formatCost(summary.estimatedCostUsd ?? null),
              label: 'Est. cost',
              bg: 'rgba(20, 71, 230, 0.1)',
              border: '1px solid rgba(20, 71, 230, 0.2)',
              valueColor: '#93b4ff',
              valueFontSize: 16
            },
            {
              value: formatTokens(totalTokens),
              label: 'Total tokens',
              bg: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              valueColor: '#fafafa',
              valueFontSize: 16
            },
            {
              value: topModel,
              label: 'Top model',
              bg: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              valueColor: '#fafafa',
              valueFontSize: 14
            }
          ].map((card, i) => (
            <div
              key={card.label}
              style={{
                display: 'inline-block',
                verticalAlign: 'top',
                width: 'calc(33.33% - 6px)',
                marginLeft: i > 0 ? 8 : 0,
                background: card.bg,
                border: card.border,
                borderRadius: 10,
                padding: '10px 12px',
                height: 52,
                overflow: 'hidden',
                boxSizing: 'border-box'
              }}
            >
              <div
                style={{
                  fontSize: card.valueFontSize,
                  fontWeight: 600,
                  color: card.valueColor,
                  lineHeight: 1.2,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}
              >
                {card.value}
              </div>
              <div style={{ fontSize: 10, color: '#666', marginTop: 2, letterSpacing: 0.2 }}>
                {card.label}
              </div>
            </div>
          ))}
        </div>

        {/* Chart */}
        <div style={{ position: 'relative', zIndex: 1 }}>
          {/* Chart header — table layout */}
          <div style={{ display: 'table', width: '100%', marginBottom: 10 }}>
            <div style={{ display: 'table-cell', verticalAlign: 'bottom' }}>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: '#555',
                  letterSpacing: 0.3,
                  textTransform: 'uppercase' as const
                }}
              >
                Daily tokens
              </span>
            </div>
            <div style={{ display: 'table-cell', verticalAlign: 'bottom', textAlign: 'right' }}>
              <span style={{ fontSize: 10, color: '#444' }}>
                {sessions} sessions · {turnsOrEvents.count} {turnsOrEvents.label}
              </span>
            </div>
          </div>

          {/* Chart: value labels + fixed-height bar area + day labels.
              Uses a wrapping div with fixed height and overflow:hidden so bars
              cannot expand the container. Segments are positioned at the bottom
              of each column via a table inside. */}
          {(() => {
            const CHART_H = 120
            const maxSegSum = Math.max(
              1,
              ...slicedDaily.map((entry) => {
                const segs = getDailySegments(entry)
                return segs.reduce((sum, s) => sum + s.value, 0)
              })
            )
            return (
              <>
                {/* Value labels */}
                <table
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    tableLayout: 'fixed',
                    marginBottom: 6
                  }}
                >
                  <tbody>
                    <tr>
                      {slicedDaily.map((entry) => (
                        <td
                          key={entry.day}
                          style={{
                            textAlign: 'center',
                            padding: '0 3px',
                            fontSize: 8,
                            color: '#444'
                          }}
                        >
                          {formatTokens(getDailyTotal(entry))}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
                {/* Bar area — fixed height */}
                <div style={{ height: CHART_H, overflow: 'hidden', marginBottom: 8 }}>
                  <table
                    style={{
                      width: '100%',
                      borderCollapse: 'collapse',
                      tableLayout: 'fixed',
                      height: '100%'
                    }}
                  >
                    <tbody>
                      <tr>
                        {slicedDaily.map((entry) => {
                          const segments = getDailySegments(entry)
                          return (
                            <td
                              key={entry.day}
                              style={{
                                verticalAlign: 'bottom',
                                textAlign: 'center',
                                padding: '0 3px'
                              }}
                            >
                              {segments.map((seg) =>
                                seg.value > 0 ? (
                                  <div
                                    key={seg.key}
                                    style={{
                                      height: Math.max(
                                        1,
                                        Math.round((seg.value / maxSegSum) * CHART_H)
                                      ),
                                      background: seg.color,
                                      marginLeft: '15%',
                                      marginRight: '15%'
                                    }}
                                  />
                                ) : null
                              )}
                            </td>
                          )
                        })}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </>
            )
          })()}

          {/* Day labels */}
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <tbody>
              <tr>
                {slicedDaily.map((entry) => (
                  <td
                    key={entry.day}
                    style={{ textAlign: 'center', fontSize: 9, color: '#555', padding: '0 3px' }}
                  >
                    {entry.day.slice(5)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>

          {/* Legend — inline-block for html2canvas compatibility */}
          <div style={{ marginTop: 10 }}>
            {getLegendItems(provider).map((item, i) => (
              <span
                key={item.label}
                style={{
                  display: 'inline-block',
                  marginRight: i < 3 ? 12 : 0,
                  fontSize: 9,
                  color: '#555',
                  lineHeight: '14px'
                }}
              >
                <span
                  style={{
                    display: 'inline-block',
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: item.color,
                    verticalAlign: 'middle',
                    marginRight: 5
                  }}
                />
                <span style={{ verticalAlign: 'middle' }}>{item.label}</span>
              </span>
            ))}
          </div>
        </div>

        {/* Footer — table layout */}
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
              <strong style={{ color: '#ccc' }}>{formatTokens(summary.inputTokens)}</strong> input
            </span>
            <span style={{ fontSize: 12, color: '#888', marginLeft: 16 }}>
              <strong style={{ color: '#ccc' }}>{formatTokens(summary.outputTokens)}</strong> output
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
      </div>
    )
  }
)

function OrcaLogo(): React.JSX.Element {
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

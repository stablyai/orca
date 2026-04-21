import { forwardRef } from 'react'
import type { ClaudeUsageSummary } from '../../../../shared/claude-usage-types'
import type { CodexUsageSummary } from '../../../../shared/codex-usage-types'
import {
  BackgroundGlows,
  CardFooter,
  formatCost,
  formatDateRange,
  formatTokens,
  getDailySegments,
  getDailyTotal,
  getLegendItems,
  OrcaLogo,
  RANGE_LABELS
} from './share-card-utils'
import type { ClaudeShareData, CodexShareData } from './share-card-utils'

export type ShareUsageCardProps = (ClaudeShareData | CodexShareData) & {
  range: string
}

// Why: html-to-image uses SVG foreignObject which handles modern CSS fine,
// but inline styles are kept for portability and to avoid Tailwind class stripping.
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
        <BackgroundGlows />
        <CardHeader providerLabel={providerLabel} range={range} />

        <div
          style={{ fontSize: 11, color: '#555', position: 'relative', zIndex: 1, marginBottom: 16 }}
        >
          {formatDateRange(range)}
        </div>

        <StatsGrid summary={summary} totalTokens={totalTokens} topModel={topModel} />

        <div style={{ position: 'relative', zIndex: 1 }}>
          <ChartHeader sessions={sessions} turnsOrEvents={turnsOrEvents} />
          <DailyChart slicedDaily={slicedDaily} />
          <DayLabels slicedDaily={slicedDaily} />
          <Legend provider={provider} />
        </div>

        <CardFooter summary={summary} />
      </div>
    )
  }
)

function CardHeader(props: { providerLabel: string; range: string }): React.JSX.Element {
  return (
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
            {props.providerLabel} Usage
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
          {RANGE_LABELS[props.range] ?? props.range}
        </span>
      </div>
    </div>
  )
}

function StatsGrid(props: {
  summary: { estimatedCostUsd: number | null }
  totalTokens: number
  topModel: string
}): React.JSX.Element {
  const cards = [
    {
      value: formatCost(props.summary.estimatedCostUsd ?? null),
      label: 'Est. cost',
      bg: 'rgba(20, 71, 230, 0.1)',
      border: '1px solid rgba(20, 71, 230, 0.2)',
      valueColor: '#93b4ff',
      valueFontSize: 16
    },
    {
      value: formatTokens(props.totalTokens),
      label: 'Total tokens',
      bg: 'rgba(255, 255, 255, 0.04)',
      border: '1px solid rgba(255, 255, 255, 0.06)',
      valueColor: '#fafafa',
      valueFontSize: 16
    },
    {
      value: props.topModel,
      label: 'Top model',
      bg: 'rgba(255, 255, 255, 0.04)',
      border: '1px solid rgba(255, 255, 255, 0.06)',
      valueColor: '#fafafa',
      valueFontSize: 14
    }
  ]
  return (
    <div style={{ position: 'relative', zIndex: 1, marginBottom: 20 }}>
      {cards.map((card, i) => (
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
  )
}

function ChartHeader(props: {
  sessions: number
  turnsOrEvents: { label: string; count: number }
}): React.JSX.Element {
  return (
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
          {props.sessions} sessions · {props.turnsOrEvents.count} {props.turnsOrEvents.label}
        </span>
      </div>
    </div>
  )
}

function DailyChart(props: {
  slicedDaily: Parameters<typeof getDailySegments>[0][]
}): React.JSX.Element {
  const CHART_H = 120
  const maxSegSum = Math.max(
    1,
    ...props.slicedDaily.map((entry) => {
      const segs = getDailySegments(entry)
      return segs.reduce((sum, s) => sum + s.value, 0)
    })
  )
  return (
    <>
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
            {props.slicedDaily.map((entry) => (
              <td
                key={entry.day}
                style={{ textAlign: 'center', padding: '0 3px', fontSize: 8, color: '#444' }}
              >
                {formatTokens(getDailyTotal(entry))}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
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
              {props.slicedDaily.map((entry) => {
                const segments = getDailySegments(entry)
                return (
                  <td
                    key={entry.day}
                    style={{ verticalAlign: 'bottom', textAlign: 'center', padding: '0 3px' }}
                  >
                    {segments.map((seg) =>
                      seg.value > 0 ? (
                        <div
                          key={seg.key}
                          style={{
                            height: Math.max(1, Math.round((seg.value / maxSegSum) * CHART_H)),
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
}

function DayLabels(props: { slicedDaily: { day: string }[] }): React.JSX.Element {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
      <tbody>
        <tr>
          {props.slicedDaily.map((entry) => (
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
  )
}

function Legend(props: { provider: 'claude' | 'codex' }): React.JSX.Element {
  return (
    <div style={{ marginTop: 10 }}>
      {getLegendItems(props.provider).map((item, i) => (
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
  )
}

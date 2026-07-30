import { ContextPressureIndicator } from '@/components/ContextPressureIndicator'
import { useTabContextPressure } from '@/components/sidebar/context-pressure-selection'

/** Worst-of context pressure across a terminal tab's panes. Aggregate surface:
 *  renders only at warning/critical; unknown or 'ok' renders nothing. */
export function TerminalTabContextPressure({ tabId }: { tabId: string }): React.JSX.Element | null {
  const pressure = useTabContextPressure(tabId)
  if (!pressure) {
    return null
  }
  return (
    <ContextPressureIndicator
      level={pressure.level}
      usedPercent={pressure.usedPercent}
      usedTokens={pressure.usedTokens}
      limitTokens={pressure.limitTokens}
      limitSource={pressure.limitSource}
      usedTokensSource={pressure.usedTokensSource}
      size="sm"
      tooltipSide="bottom"
      className="mr-1"
    />
  )
}

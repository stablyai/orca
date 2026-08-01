import { useShallow } from 'zustand/react/shallow'
import { ContextPressureIndicator } from '@/components/ContextPressureIndicator'
import {
  getContextPressureConfig,
  resolveEntryContextPressure
} from '@/components/sidebar/context-pressure-selection'
import { useAppStore } from '@/store'
import type { ContextPressureSnapshot } from '../../../../shared/agent-context-pressure'

const EMPTY_ENTRY = null

type PressureTuple = readonly [
  ContextPressureSnapshot['level'],
  number,
  number,
  number,
  ContextPressureSnapshot['limitSource'],
  ContextPressureSnapshot['usedTokensSource']
]

export function AutomationRunContextPressure({
  paneKey
}: {
  paneKey: string | null
}): React.JSX.Element | null {
  const pressure = useAppStore(
    useShallow((state): PressureTuple | null => {
      if (!paneKey) {
        return null
      }
      const entry = state.agentStatusByPaneKey?.[paneKey] ?? EMPTY_ENTRY
      const config = getContextPressureConfig(state.settings)
      const snapshot = entry ? resolveEntryContextPressure(entry, config) : null
      return snapshot
        ? [
            snapshot.level,
            snapshot.usedTokens,
            snapshot.limitTokens,
            snapshot.usedPercent,
            snapshot.limitSource,
            snapshot.usedTokensSource
          ]
        : null
    })
  )
  return pressure ? (
    <ContextPressureIndicator
      level={pressure[0]}
      usedTokens={pressure[1]}
      limitTokens={pressure[2]}
      usedPercent={pressure[3]}
      limitSource={pressure[4]}
      usedTokensSource={pressure[5]}
      tooltipSide="bottom"
    />
  ) : null
}

import { useCallback, useState } from 'react'
import type { FleetTeamOpenChange, FleetTeamOpenOverrides } from './FleetProjectSection'

export function useFleetTeamOpenOverrides(): [FleetTeamOpenOverrides, FleetTeamOpenChange] {
  const [overrides, setOverrides] = useState<FleetTeamOpenOverrides>(() => new Map())
  const change = useCallback<FleetTeamOpenChange>((rootPaneKey, open) => {
    setOverrides((previous) => new Map(previous).set(rootPaneKey, open))
  }, [])
  return [overrides, change]
}

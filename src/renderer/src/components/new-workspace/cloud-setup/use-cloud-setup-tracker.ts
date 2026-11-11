// B2 for Orca Cloud setup: the setup rows with the "Switch to <team>" Team row swapped in.
import { useMemo } from 'react'
import type { CloudSetupStep } from '@/components/new-workspace/run-on/cloud-start-model'
import {
  applySwitchTeamStep,
  useCloudSetupSwitchTeam,
  type CloudSetupSwitchTeam
} from './CloudSetupSwitchTeam'

/** B2 applied to the setup rows: the rows to show, and the switch when it holds Start. */
export function useSwitchTeamSteps(
  baseSteps: CloudSetupStep[],
  enabled: boolean
): { steps: CloudSetupStep[]; held: CloudSetupSwitchTeam | null } {
  const switchTeam = useCloudSetupSwitchTeam(enabled)
  const teamStep = switchTeam?.step
  const switched = useMemo(
    () => (teamStep ? applySwitchTeamStep(baseSteps, teamStep) : null),
    [baseSteps, teamStep]
  )
  return { steps: switched ?? baseSteps, held: switched ? switchTeam : null }
}

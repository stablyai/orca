import { useAppStore } from '@/store'
import {
  isOrcaCloudTeamFeatureBlocked,
  type OrcaCloudTeamFeatureFlag
} from '../../../shared/orca-profiles/orca-cloud-team-policy'

export function useOrcaTeamFeatureBlocked(flag: OrcaCloudTeamFeatureFlag): boolean {
  return useAppStore((state) => isOrcaCloudTeamFeatureBlocked(state.orcaProfileAuthStatus, flag))
}

import { useAppStore } from '../index'
import { getProjectHostSetupProjectionFromState } from './project-host-setup-selector'

export const useProjectHostSetupProjection = () =>
  useAppStore((s) => getProjectHostSetupProjectionFromState(s))

import { getDefaultCloneParent } from '../../../../shared/clone-destination'

export {
  getDefaultCloneParent,
  getDefaultProjectsCloneParent
} from '../../../../shared/clone-destination'

export function getCloneDestinationAutoFill({
  step,
  cloneDestination,
  activeRuntimeEnvironmentId,
  sshTargetId,
  workspaceDir,
  cloneStepAutoFilled
}: {
  step: string
  cloneDestination: string
  activeRuntimeEnvironmentId: string | null | undefined
  sshTargetId?: string | null | undefined
  workspaceDir: string | null | undefined
  cloneStepAutoFilled: boolean
}): { destination: string } | null {
  if (step !== 'clone' || cloneStepAutoFilled || cloneDestination) {
    return null
  }
  if (activeRuntimeEnvironmentId?.trim() || sshTargetId?.trim() || !workspaceDir) {
    return null
  }
  return { destination: getDefaultCloneParent(workspaceDir) }
}

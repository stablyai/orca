import { captureWorktreeSshMutationExpectation } from '@/lib/ssh-mutation-expectation'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'

export function captureRuntimeTerminalDropOwner(worktreeId: string):
  | ({
      runtimeEnvironmentId: string
      assertCurrent: () => void
    } & ReturnType<typeof captureWorktreeSshMutationExpectation>)
  | null {
  const state = useAppStore.getState()
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  if (!runtimeEnvironmentId) {
    return null
  }
  const expectation = captureWorktreeSshMutationExpectation(state, worktreeId)
  const assertCurrent = (): void => {
    const currentState = useAppStore.getState()
    const currentRuntimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(currentState, worktreeId)
    const currentExpectation = captureWorktreeSshMutationExpectation(currentState, worktreeId)
    if (
      currentRuntimeEnvironmentId !== runtimeEnvironmentId ||
      currentExpectation.expectedExecutionHostId !== expectation.expectedExecutionHostId ||
      currentExpectation.expectedSshTargetId !== expectation.expectedSshTargetId ||
      currentExpectation.expectedSshConnectionGeneration !==
        expectation.expectedSshConnectionGeneration
    ) {
      throw new Error('Terminal upload host changed; retry the drop.')
    }
  }
  return { runtimeEnvironmentId, assertCurrent, ...expectation }
}

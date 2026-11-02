import type { RefObject } from 'react'
import type { OrcaHooks, SetupAgentStartupPolicy } from '../../../../shared/orca-yaml-hook-types'
import type { HookCheckResult } from '@/runtime/runtime-hooks-client'

export type ComposerProviderSyncModel = {
  persistedSetupAgentStartupPolicy: SetupAgentStartupPolicy
  persistSetupAgentStartupPolicy: (policy?: SetupAgentStartupPolicy) => Promise<boolean>
  handleSetupAgentStartupPolicyChange: (policy: SetupAgentStartupPolicy) => void
  cancelPromptCaretFrame: () => void
  handleComposerNodeChange: (node: HTMLDivElement | null) => void
  hookCheckRef: RefObject<{ key: string; promise: Promise<HookCheckResult> } | null>
  /** `background`: the open-time check, refused rather than booting a stopped WSL distro. */
  loadHookCheckForRepo: (
    targetRepoId: string,
    options?: { background?: boolean }
  ) => Promise<HookCheckResult>
  commitHookCheckIfCurrent: (targetContextKey: string, hooks: OrcaHooks | null) => boolean
}

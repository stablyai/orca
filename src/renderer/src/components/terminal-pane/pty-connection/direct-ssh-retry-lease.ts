import type { DirectSshPaneRetryAttempt } from '@/store/slices/direct-ssh-terminal-recovery'

export type DirectSshRetryLease = Pick<
  DirectSshPaneRetryAttempt,
  'attemptId' | 'authority' | 'tabGeneration'
>

import type { GlobalSettings } from '../../../../shared/types'
import {
  sendRuntimePtyInput,
  sendRuntimePtyInputVerified
} from '@/runtime/runtime-terminal-inspection'

export type NativeChatRuntimeSettings =
  | Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  | null
  | undefined

export type NativeChatPtyWriter = {
  /** Secondary renderers must await each authorized IPC write before advancing. */
  requiresWriteAcceptance?: boolean
  write: (settings: NativeChatRuntimeSettings, ptyId: string, data: string) => boolean
  writeAccepted: (
    settings: NativeChatRuntimeSettings,
    ptyId: string,
    data: string
  ) => Promise<boolean>
}

export const runtimeNativeChatPtyWriter: NativeChatPtyWriter = {
  write: (...args) => sendRuntimePtyInput(...args),
  writeAccepted: (...args) => sendRuntimePtyInputVerified(...args)
}

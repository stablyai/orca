import type { StateCreator } from 'zustand'
import type { AppState } from '../../../types'
import {
  mirrorStructuredChatProviders,
  type StructuredChatProviderFact
} from '@/runtime/web-session-tabs-sync/snapshots/store-patch'
import { withStructuredChatSleptAt } from './structured-chat-slept-at'
import {
  withoutStructuredSessionLaunchDirectory,
  withStructuredSessionLaunchDirectory
} from './structured-session-launch-directories'

export type StructuredChatCompanionWrite =
  | { kind: 'slept-at'; paneKey: string; sleptAt: number | null | undefined }
  | ({ kind: 'provider' } & StructuredChatProviderFact)
  | { kind: 'launch-directory'; tabId: string; sessionId: string; launchDirectory: string }
  | { kind: 'clear-launch-directory'; tabId: string; sessionId: string }

export type StructuredChatCompanionWritesSlice = {
  /** Batch each kind of host evidence, so a reconnect does not notify once per chat. */
  applyStructuredChatCompanionWrites: (writes: readonly StructuredChatCompanionWrite[]) => void
}

export const createStructuredChatCompanionWritesSlice: StateCreator<
  AppState,
  [],
  [],
  StructuredChatCompanionWritesSlice
> = (set) => ({
  applyStructuredChatCompanionWrites: (writes) => {
    if (!writes.length) {
      return
    }
    const providers: StructuredChatProviderFact[] = []
    set((state) => {
      let sleptAt = state.structuredChatSleptAtByPaneKey
      let directories = state.structuredSessionLaunchDirectoryByTabId
      for (const write of writes) {
        if (write.kind === 'slept-at') {
          sleptAt = withStructuredChatSleptAt(sleptAt, write.paneKey, write.sleptAt)
        } else if (write.kind === 'provider') {
          providers.push(write)
        } else if (write.kind === 'launch-directory') {
          directories = withStructuredSessionLaunchDirectory(
            directories,
            write.tabId,
            write.sessionId,
            write.launchDirectory
          )
        } else {
          directories = withoutStructuredSessionLaunchDirectory(
            directories,
            write.tabId,
            write.sessionId
          )
        }
      }
      if (
        sleptAt === state.structuredChatSleptAtByPaneKey &&
        directories === state.structuredSessionLaunchDirectoryByTabId
      ) {
        return state
      }
      return {
        ...(sleptAt !== state.structuredChatSleptAtByPaneKey
          ? { structuredChatSleptAtByPaneKey: sleptAt }
          : {}),
        ...(directories !== state.structuredSessionLaunchDirectoryByTabId
          ? { structuredSessionLaunchDirectoryByTabId: directories }
          : {})
      }
    })
    if (providers.length) {
      mirrorStructuredChatProviders(providers)
    }
  }
})

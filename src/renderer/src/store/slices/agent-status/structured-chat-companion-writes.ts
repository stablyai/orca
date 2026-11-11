import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import { withStructuredChatSleptAt } from './structured-chat-slept-at'
import {
  withoutStructuredSessionLaunchDirectory,
  withStructuredSessionLaunchDirectory
} from './structured-session-launch-directories'

/** A status projection's sleep and launch-directory side facts, applied in order. */
export type StructuredChatCompanionWrite =
  | { kind: 'slept-at'; paneKey: string; sleptAt: number | null | undefined }
  | { kind: 'launch-directory'; tabId: string; sessionId: string; launchDirectory: string }
  | { kind: 'clear-launch-directory'; tabId: string; sessionId: string }

export type StructuredChatCompanionWritesSlice = {
  /** One store write per projection, so a reconnect snapshot does not notify once per chat. */
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
    set((state) => {
      let sleptAt = state.structuredChatSleptAtByPaneKey
      let directories = state.structuredSessionLaunchDirectoryByTabId
      for (const write of writes) {
        if (write.kind === 'slept-at') {
          sleptAt = withStructuredChatSleptAt(sleptAt, write.paneKey, write.sleptAt)
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
  }
})

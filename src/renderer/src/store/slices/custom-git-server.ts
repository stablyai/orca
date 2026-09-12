import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  CustomGitServer,
  CustomGitServerDraft,
  CustomGitServerTestResult
} from '../../../../shared/custom-git-server'

// The custom-git-server config is stored on the local main process (like the
// Jira/Linear connection stores), so mutations go straight through window.api.
// Per-server auth STATUS is surfaced via preflight (preflightStatus.customGitServers);
// save/remove trigger a forced preflight refresh so cards update immediately.
export type CustomGitServerSlice = {
  saveCustomGitServer: (draft: CustomGitServerDraft & { id?: string }) => Promise<CustomGitServer>
  removeCustomGitServer: (id: string) => Promise<void>
  testCustomGitServer: (
    draft: CustomGitServerDraft & { token: string }
  ) => Promise<CustomGitServerTestResult>
}

/** Store slice for custom-git-server save/remove/test, forcing a preflight refresh on mutation. */
export const createCustomGitServerSlice: StateCreator<AppState, [], [], CustomGitServerSlice> = (
  _set,
  get
) => ({
  saveCustomGitServer: async (draft) => {
    const server = await window.api.customGitServer.save(draft)
    await get().refreshPreflightStatus({ force: true })
    return server
  },
  removeCustomGitServer: async (id) => {
    await window.api.customGitServer.remove({ id })
    await get().refreshPreflightStatus({ force: true })
  },
  testCustomGitServer: (draft) => window.api.customGitServer.test(draft)
})

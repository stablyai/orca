import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type {
  VoloConnectArgs,
  VoloConnectResult,
  VoloConnectionStatus,
  VoloGoogleLoginResult
} from '../../../../shared/volo-types'

export type VoloSlice = {
  voloStatus: VoloConnectionStatus
  voloStatusChecked: boolean
  voloStatusContextKey: string | null
  checkVoloConnection: () => Promise<void>
  connectVolo: (args: VoloConnectArgs) => Promise<VoloConnectResult>
  connectVoloFromSavedCredentials: () => Promise<VoloConnectResult>
  connectVoloWithGoogle: (apiUrl?: string) => Promise<VoloGoogleLoginResult>
  testVoloConnection: () => Promise<VoloConnectResult>
  disconnectVolo: () => Promise<void>
  readVoloStatus: (sourceContext: TaskSourceContext) => Promise<VoloConnectionStatus>
}

type VoloStateCreator = StateCreator<AppState, [], [], VoloSlice>

export type VoloSliceSet = Parameters<VoloStateCreator>[0]
export type VoloSliceGet = Parameters<VoloStateCreator>[1]

import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  PluginTaskItem,
  PluginTaskSourceErrorCode
} from '../../../../shared/plugins/plugin-task-source-contract'

/** A plugin's contribution to the Tasks source bar. */
export type ContributedPluginTaskSource = {
  pluginKey: string
  sourceId: string
  title: string
  icon?: string
}

export type SelectedPluginTaskSource = {
  pluginKey: string
  sourceId: string
}

/** Keeps the closed error taxonomy visible in state, so "token expired" and
 *  "worker died" stay distinguishable instead of collapsing into one string. */
export type PluginTaskSourceLoadError = {
  code: PluginTaskSourceErrorCode
  message: string
}

export type PluginTaskSourcesSlice = {
  /** Populated by `setPluginTaskSources` from the plugin list; this slice
   *  never fetches plugins itself — that stays owned by `usePluginPanelsStore`. */
  pluginTaskSources: ContributedPluginTaskSource[]
  selectedPluginTaskSource: SelectedPluginTaskSource | null
  pluginTaskSourceItems: PluginTaskItem[]
  pluginTaskSourceLoading: boolean
  pluginTaskSourceError: PluginTaskSourceLoadError | null

  setPluginTaskSources: (sources: ContributedPluginTaskSource[]) => void
  selectPluginTaskSource: (selection: SelectedPluginTaskSource | null) => void
  loadPluginTaskSourceItems: () => Promise<void>
}

type PluginTaskSourcesStateCreator = StateCreator<AppState, [], [], PluginTaskSourcesSlice>

export type PluginTaskSourcesSliceSet = Parameters<PluginTaskSourcesStateCreator>[0]
export type PluginTaskSourcesSliceGet = Parameters<PluginTaskSourcesStateCreator>[1]

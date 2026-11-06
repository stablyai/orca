import { create } from 'zustand'
import type { PluginDeclarativeNode } from '../../../shared/plugins/declarative/plugin-declarative-catalog'

/** `orca plugin shot --scenario`: a tree drawn detached from any plugin, for one capture. */
export type PluginShotReplayPreview = {
  /** Already passed `parsePluginDeclarativeTree`. */
  tree: PluginDeclarativeNode | null
  /** CSS pixels. */
  width: number
  /** New per request, so a later replay remounts rather than reuses value controls' edits. */
  id: number
}

type PluginShotReplayState = {
  preview: PluginShotReplayPreview | null
  show: (preview: PluginShotReplayPreview) => void
  clear: () => void
}

export const usePluginShotReplayStore = create<PluginShotReplayState>()((set) => ({
  preview: null,
  show: (preview) => set({ preview }),
  clear: () => set({ preview: null })
}))

import { create } from 'zustand'

/** What `orca plugin shot` changes for one capture: never written to settings or the layout. */
type PluginViewCaptureState = {
  /** Right-sidebar panel width in CSS pixels, or null for the user's own. */
  panelWidth: number | null
  /** Paint Orca dark (true) or light (false), or null for the Appearance setting. */
  dark: boolean | null
  /** A capture is running: Orca's floating controls stay out of the picture. */
  capturing: boolean
  /** `shot --editor`: the open file whose editor is sized to `editorSize` for the capture. */
  editorFileId: string | null
  editorSize: { width: number; height: number } | null
  /** Editor captures per file: each one loads the editor afresh, so it reports this load's errors. */
  editorLoads: Readonly<Record<string, number>>
  begin: (overrides: {
    panelWidth: number | null
    dark: boolean | null
    editorFileId?: string | null
    editorSize?: { width: number; height: number } | null
  }) => void
  setPanelWidth: (panelWidth: number) => void
  end: () => void
}

export const usePluginViewCaptureStore = create<PluginViewCaptureState>()((set) => ({
  panelWidth: null,
  dark: null,
  capturing: false,
  editorFileId: null,
  editorSize: null,
  editorLoads: {},
  begin: (overrides) =>
    set((state) => ({
      editorFileId: null,
      editorSize: null,
      ...overrides,
      capturing: true,
      editorLoads: overrides.editorFileId
        ? {
            ...state.editorLoads,
            [overrides.editorFileId]: (state.editorLoads[overrides.editorFileId] ?? 0) + 1
          }
        : state.editorLoads
    })),
  setPanelWidth: (panelWidth) => set({ panelWidth }),
  end: () =>
    set({ panelWidth: null, dark: null, capturing: false, editorFileId: null, editorSize: null })
}))

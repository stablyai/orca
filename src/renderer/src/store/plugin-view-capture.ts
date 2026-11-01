import { create } from 'zustand'

/** What `orca plugin shot` changes for one capture: never written to settings or the layout. */
type PluginViewCaptureState = {
  /** Right-sidebar panel width in CSS pixels, or null for the user's own. */
  panelWidth: number | null
  /** Paint Orca dark (true) or light (false), or null for the Appearance setting. */
  dark: boolean | null
  begin: (overrides: { panelWidth: number | null; dark: boolean | null }) => void
  setPanelWidth: (panelWidth: number) => void
  end: () => void
}

export const usePluginViewCaptureStore = create<PluginViewCaptureState>()((set) => ({
  panelWidth: null,
  dark: null,
  begin: (overrides) => set(overrides),
  setPanelWidth: (panelWidth) => set({ panelWidth }),
  end: () => set({ panelWidth: null, dark: null })
}))

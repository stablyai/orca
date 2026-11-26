import { useAppStore } from '@/store/index'
import { applyArrivedLinkFields, linkFieldsOf } from './link-preference-publication'
import type { LinkPreferenceWriter } from './link-preference-operation'

/** Writes through the store's acknowledged path and reconciles with one read applied on arrival. */
export const storeLinkPreferenceWriter: LinkPreferenceWriter = {
  updateSettingsOrThrow: (updates, onAcknowledged) =>
    useAppStore.getState().updateSettingsOrThrow(updates, onAcknowledged),
  reconcile: async () => {
    try {
      const read = await window.api.settings.get()
      applyArrivedLinkFields(useAppStore.setState, read)
      const settings = useAppStore.getState().settings
      return settings ? linkFieldsOf(settings) : null
    } catch {
      return null
    }
  }
}

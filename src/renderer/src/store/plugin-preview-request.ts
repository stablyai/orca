import { create } from 'zustand'

type PluginPreviewRequest = { marketplaceSourceId: string; pluginKey: string }

/** A marketplace preview asked for from outside Settings; the marketplace browser opens it. */
export const usePluginPreviewRequestStore = create<{ request: PluginPreviewRequest | null }>()(
  () => ({ request: null })
)

export function requestPluginPreview(request: PluginPreviewRequest): void {
  usePluginPreviewRequestStore.setState({ request })
}

import { create } from 'zustand'

/** Held updates the user asked to review, from anywhere in Orca; the app-level host shows them. */
export const usePluginUpdateReviewDialogStore = create<{
  request: { pluginKeys: readonly string[]; id: number } | null
}>(() => ({ request: null }))

let requests = 0

export function openPluginUpdateReviewDialog(pluginKeys: readonly string[]): void {
  requests += 1
  usePluginUpdateReviewDialogStore.setState({ request: { pluginKeys, id: requests } })
}

export function closePluginUpdateReviewDialog(): void {
  usePluginUpdateReviewDialogStore.setState({ request: null })
}

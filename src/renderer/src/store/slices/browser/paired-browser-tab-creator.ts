import type { CreateWebRuntimeSessionBrowserTabArgs } from '@/runtime/web-runtime-browser-creation-context'

type PairedBrowserTabCreator = (args: CreateWebRuntimeSessionBrowserTabArgs) => Promise<boolean>

let registeredCreator: PairedBrowserTabCreator | null = null

// Why: the runtime imports the store, so its loaded module registers a synchronous creation path.
// Cold calls use the lazy import below and stage once it resolves.
export function registerPairedBrowserTabCreator(create: PairedBrowserTabCreator): void {
  registeredCreator = create
}

export function getRegisteredPairedBrowserTabCreator(): PairedBrowserTabCreator | null {
  return registeredCreator
}

export async function loadPairedBrowserTabCreator(): Promise<PairedBrowserTabCreator> {
  const { createWebRuntimeSessionBrowserTab } =
    await import('@/runtime/web-runtime-browser-creation')
  return createWebRuntimeSessionBrowserTab
}

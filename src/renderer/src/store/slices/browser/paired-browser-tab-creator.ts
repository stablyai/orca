import type { CreateWebRuntimeSessionBrowserTabArgs } from '@/runtime/web-runtime-browser-creation-context'

type PairedBrowserTabCreator = (args: CreateWebRuntimeSessionBrowserTabArgs) => Promise<boolean>

let registeredCreator: PairedBrowserTabCreator | null = null

// Runtime imports store; register synchronous staging once loaded, lazy-import for cold calls.
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

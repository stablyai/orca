import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { BROWSER_SCREENCAST_RUNTIME_CAPABILITY } from '../../../../../shared/browser/runtime/browser-runtime-capabilities'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { openWorkspaceBrowserTab } from '@/lib/browser/workspace/workspace-browser-tab-open'
import { resolveBrowserSourceUnifiedTab } from '@/lib/browser/workspace/browser-workspace-source-resolution'

export type SandboxOnlyBrowserPage = {
  /** False when the runtime cannot stream (Orca Cloud's orcad); null while unknown, which keeps the stream path. */
  screencastSupported: boolean | null
  opening: boolean
  error: string | null
  openOnThisComputer: () => void
}

/**
 * Orca Cloud's orcad hosts agent pages in a headless browser it cannot stream; offer a
 * desktop-hosted copy of the page instead.
 */
export function useSandboxOnlyBrowserPage(input: {
  pageId: string
  url: string
  runtimeEnvironmentId: string
  worktreeId: string
}): SandboxOnlyBrowserPage {
  const { pageId, url, runtimeEnvironmentId, worktreeId } = input
  const [screencastSupported, setScreencastSupported] = useState<boolean | null>(null)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void runtimeEnvironmentSupportsCapability(
      runtimeEnvironmentId,
      BROWSER_SCREENCAST_RUNTIME_CAPABILITY
    )
      .then((supported) => {
        if (!cancelled) {
          setScreencastSupported(supported)
        }
      })
      .catch(() => {
        // Unknown support keeps the stream path, which reports its own failures.
        if (!cancelled) {
          setScreencastSupported(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [runtimeEnvironmentId])

  const openOnThisComputer = useCallback(() => {
    const sourceUnifiedTab = resolveBrowserSourceUnifiedTab(
      useAppStore.getState(),
      pageId,
      worktreeId
    )
    setOpening(true)
    setError(null)
    // A new focused desktop-hosted tab beside this one; the sandbox tab stays so the agent's tab id remains valid.
    // Desktop-hosted cloud pages tunnel loopback through the sandbox, so localhost reaches the sandbox's server.
    void openWorkspaceBrowserTab({
      workspaceId: worktreeId,
      url,
      ...(sourceUnifiedTab ? { afterTabId: sourceUnifiedTab.id } : {}),
      focusOnCreate: true,
      selectWorktree: false,
      intent: { kind: 'url' },
      expectedRuntimeEnvironmentId: runtimeEnvironmentId,
      placementPreference: 'auto'
    })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setOpening(false))
  }, [pageId, url, runtimeEnvironmentId, worktreeId])

  return { screencastSupported, opening, error, openOnThisComputer }
}

import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { BROWSER_SCREENCAST_RUNTIME_CAPABILITY } from '../../../../../shared/browser/runtime/browser-runtime-capabilities'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { openWorkspaceBrowserTab } from '@/lib/browser/workspace/workspace-browser-tab-open'
import { resolveBrowserSourceUnifiedTab } from '@/lib/browser/workspace/browser-workspace-source-resolution'
import { isOrcaCloudEnvironmentId } from '@/lib/orca-cloud/orca-cloud-environment-id'

export type SandboxOnlyBrowserPage = {
  /** False when the runtime cannot stream (Orca Cloud's orcad); null while unknown, which keeps the stream path. */
  screencastSupported: boolean | null
  opening: boolean
  error: boolean
  openOnThisComputer: () => void
}

/**
 * Whether the stream path may run. Orca Cloud counts as no screencast until a probe proves it (a sleeping or
 * unreachable sandbox must not fall back to "Cannot reach…" notices); other hosts stay unknown (null) until proven.
 */
export function resolveScreencastSupport(
  probe: 'pending' | 'failed' | boolean,
  isOrcaCloud: boolean
): boolean | null {
  if (typeof probe === 'boolean') {
    return probe
  }
  return isOrcaCloud ? false : null
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
  const [probe, setProbe] = useState<'pending' | 'failed' | boolean>('pending')
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState(false)
  const screencastSupported = resolveScreencastSupport(
    probe,
    isOrcaCloudEnvironmentId(runtimeEnvironmentId)
  )

  useEffect(() => {
    let cancelled = false
    setProbe('pending')
    void runtimeEnvironmentSupportsCapability(
      runtimeEnvironmentId,
      BROWSER_SCREENCAST_RUNTIME_CAPABILITY
    )
      .then((supported) => {
        if (!cancelled) {
          setProbe(supported)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProbe('failed')
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
    setError(false)
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
      .catch(() => setError(true))
      .finally(() => setOpening(false))
  }, [pageId, url, runtimeEnvironmentId, worktreeId])

  return { screencastSupported, opening, error, openOnThisComputer }
}

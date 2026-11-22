import { useMemo } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { useRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/use-runtime-environment-capability'
import { BROWSER_SITE_DISPLAY_RUNTIME_CAPABILITY } from '../../../../../shared/browser/runtime/browser-runtime-capabilities'
import type { BrowserPageSiteDisplay } from '../../../../../shared/browser/site-settings/browser-site-display'
import type { BrowserPageSiteDisplaySource } from '../assemble-chrome/toolbar/browser-page-site-display-source'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type { RemoteBrowserRuntimeTarget } from './remote-browser-page-input-model'

/** Site zoom and color scheme live in the host's browser profile, so the host reads and changes them. */
export function useRemoteBrowserPageSiteDisplaySource({
  runtimeEnvironmentId,
  lifecycle,
  runtimeTarget,
  runtimeWorktree,
  onZoomed
}: {
  runtimeEnvironmentId: string
  lifecycle: RemoteBrowserStreamLifecycle
  runtimeTarget: () => RemoteBrowserRuntimeTarget | null
  runtimeWorktree: string
  /** Frames carry the new zoom too, but a static page may not repaint before the next click. */
  onZoomed: () => void
}): BrowserPageSiteDisplaySource | null {
  const supported = useRuntimeEnvironmentCapability(
    runtimeEnvironmentId,
    BROWSER_SITE_DISPLAY_RUNTIME_CAPABILITY
  )
  return useMemo(() => {
    if (!supported) {
      return null
    }
    const call = async (
      method: 'browser.siteDisplay' | 'browser.zoom' | 'browser.setSiteColorScheme',
      params: Record<string, unknown> = {}
    ): Promise<BrowserPageSiteDisplay | null> => {
      const target = runtimeTarget()
      const page = lifecycle.tokens.remotePage
      if (!target || !page) {
        return null
      }
      return callRuntimeRpc<BrowserPageSiteDisplay | null>(
        target,
        method,
        { worktree: runtimeWorktree, page, ...params },
        { timeoutMs: 10_000, suppressFeatureInteraction: true }
      )
    }
    return {
      read: () => call('browser.siteDisplay'),
      zoom: async (direction) => {
        const display = await call('browser.zoom', { direction })
        onZoomed()
        return display
      },
      setColorScheme: (colorScheme) => call('browser.setSiteColorScheme', { colorScheme })
    }
  }, [lifecycle, onZoomed, runtimeTarget, runtimeWorktree, supported])
}

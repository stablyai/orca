import { useEffect, useState } from 'react'
import type { RuntimeTerminalPathResolution } from '../../../../../../shared/terminal/runtime-terminal-file-path'
import {
  createNativeChatFileHref,
  routeNativeChatHref
} from '../../../../../../shared/native-chat/file-access/native-chat-href-routing'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import { getLocalImageCacheKey } from '@/components/editor/document-images/useLocalImageSrc'
import type { NativeChatImageRuntimeContext } from './native-chat-image-runtime-context'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { isWslUncPath } from '../../../../../../shared/file-access/wsl-paths'

/** Resolve session-owned media on its host before choosing either bytes or file actions. */
export function useNativeChatMediaHref({
  href,
  runtimeContext,
  tabId,
  sessionId,
  active,
  retryKey,
  cwd
}: {
  href: string | undefined
  runtimeContext: NativeChatImageRuntimeContext
  /** Where relative paths resolve when not the workspace: the sub-folder an adopted chat runs in. */
  cwd?: string
  tabId?: string
  sessionId?: string | null
  active: boolean
  retryKey: number
}): { href?: string; expectedEnvironmentPairingRevision?: number } {
  const route = routeNativeChatHref(href)
  const pathText = route.kind === 'file' ? route.pathText : ''
  const resolve = Boolean(
    runtimeContext?.worktreeId &&
    !runtimeContext.connectionId &&
    !isWslUncPath(runtimeContext.worktreePath ?? '') &&
    tabId &&
    sessionId &&
    /^(?:\.\/)?images\//.test(pathText) &&
    !pathText.split(/[\\/]/).includes('..')
  )
  const identity =
    resolve && runtimeContext
      ? [getLocalImageCacheKey(pathText, undefined, runtimeContext), cwd, tabId, sessionId].join(
          '\0'
        )
      : ''
  const [resolved, setResolved] = useState<{
    identity: string
    href?: string
    expectedEnvironmentPairingRevision?: number
  }>()
  useEffect(() => {
    if (!identity || !active || !runtimeContext?.worktreeId || !tabId || !sessionId) {
      return
    }
    const controller = new AbortController()
    const expectedEnvironmentPairingRevision =
      runtimeContext.target.kind === 'environment'
        ? captureRuntimeEnvironmentRequestRevision(
            runtimeContext.target.environmentId,
            runtimeContext.expectedEnvironmentPairingRevision
          )
        : undefined
    void callRuntimeRpc<RuntimeTerminalPathResolution>(
      runtimeContext.target,
      'files.resolveTerminalPath',
      {
        worktree: toRuntimeWorktreeSelector(runtimeContext.worktreeId),
        pathText,
        cwd: cwd ?? runtimeContext.worktreePath,
        nativeChatContext: { tabId, sessionId }
      },
      {
        signal: controller.signal,
        timeoutMs: 15_000,
        suppressFeatureInteraction: true,
        expectedEnvironmentPairingRevision
      }
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setResolved({
            identity,
            expectedEnvironmentPairingRevision,
            href:
              result.exists && !result.isDirectory && result.absolutePath
                ? createNativeChatFileHref(result.absolutePath, 'literal')
                : undefined
          })
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setResolved({ identity })
        }
      })
    return () => controller.abort()
  }, [identity, active, runtimeContext, tabId, sessionId, pathText, retryKey, cwd])
  return !resolve ? { href } : resolved?.identity === identity ? resolved : {}
}

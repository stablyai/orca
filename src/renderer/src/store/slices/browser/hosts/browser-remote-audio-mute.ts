import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import { BROWSER_AUDIO_MUTE_RUNTIME_CAPABILITY } from '../../../../../../shared/browser/runtime/browser-runtime-capabilities'
import type { RemoteBrowserPageHandle } from '../browser-slice-contract'

/** A streamed page plays on its host, so the host mutes it; resolves false when the host can't. */
export async function setRemoteBrowserPageAudioMuted(
  worktreeId: string,
  handle: RemoteBrowserPageHandle,
  muted: boolean
): Promise<boolean> {
  if (
    handle.staged ||
    !(await runtimeEnvironmentSupportsCapability(
      handle.environmentId,
      BROWSER_AUDIO_MUTE_RUNTIME_CAPABILITY
    ))
  ) {
    return false
  }
  await callRuntimeRpc(
    { kind: 'environment', environmentId: handle.environmentId },
    'browser.setAudioMuted',
    { worktree: toRuntimeWorktreeSelector(worktreeId), page: handle.remotePageId, muted },
    { timeoutMs: 10_000, suppressFeatureInteraction: true }
  )
  return true
}

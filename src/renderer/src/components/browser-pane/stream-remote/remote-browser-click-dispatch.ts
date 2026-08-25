import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { isRemoteBrowserMethodUnsupportedError } from './remote-browser-stream-errors'
import type {
  RemoteBrowserPressState,
  RemoteBrowserRuntimeTarget
} from './remote-browser-page-input-model'

const CALL_OPTIONS = { timeoutMs: 15_000, suppressFeatureInteraction: true }

type RemoteBrowserClickParams = { worktree: string; page: string }

async function moveRemoteBrowserPointer(
  target: RemoteBrowserRuntimeTarget,
  params: RemoteBrowserClickParams,
  point: { x: number; y: number }
): Promise<void> {
  await callRuntimeRpc(
    target,
    'browser.mouseMove',
    { ...params, x: point.x, y: point.y },
    CALL_OPTIONS
  )
}

// Why one atomic mouseClick when the pair is a plain click: press/release in one host-side call
// halves the round trips and cannot miss a small control between them. Drags and modified clicks
// still need the chain, which is also the fallback for hosts predating mouseClick.
export async function sendRemoteBrowserClick({
  target,
  params,
  press,
  release,
  preferAtomicClick,
  onAtomicClickUnsupported
}: {
  target: RemoteBrowserRuntimeTarget
  params: RemoteBrowserClickParams
  press: RemoteBrowserPressState
  release: RemoteBrowserPressState
  preferAtomicClick: boolean
  onAtomicClickUnsupported: () => void
}): Promise<void> {
  if (preferAtomicClick) {
    try {
      // Why the move first: the host's mouseClick dispatches only mousePressed/mouseReleased, so
      // without it the page never applies :hover — a hover-revealed control is hit-tested while it
      // is still hidden, and the press and release land on different elements.
      await moveRemoteBrowserPointer(target, params, release.point)
      await callRuntimeRpc(
        target,
        'browser.mouseClick',
        { ...params, x: release.point.x, y: release.point.y, button: release.button },
        CALL_OPTIONS
      )
      return
    } catch (error) {
      if (!isRemoteBrowserMethodUnsupportedError(error)) {
        throw error
      }
      onAtomicClickUnsupported()
    }
  }
  await sendRemoteBrowserPressHold({ target, params, press })
  await sendRemoteBrowserHeldRelease({ target, params, press, release })
}

// Puts the remote button down at the press point, for a press the user is still holding.
export async function sendRemoteBrowserPressHold({
  target,
  params,
  press
}: {
  target: RemoteBrowserRuntimeTarget
  params: RemoteBrowserClickParams
  press: RemoteBrowserPressState
}): Promise<void> {
  await moveRemoteBrowserPointer(target, params, press.point)
  await callRuntimeRpc(
    target,
    'browser.mouseDown',
    { ...params, button: press.button },
    CALL_OPTIONS
  )
}

// Releases a button that is already down remotely, moving first when the release point moved.
export async function sendRemoteBrowserHeldRelease({
  target,
  params,
  press,
  release
}: {
  target: RemoteBrowserRuntimeTarget
  params: RemoteBrowserClickParams
  press: RemoteBrowserPressState
  release: RemoteBrowserPressState
}): Promise<void> {
  if (press.point.x !== release.point.x || press.point.y !== release.point.y) {
    await moveRemoteBrowserPointer(target, params, release.point)
  }
  await callRuntimeRpc(
    target,
    'browser.mouseUp',
    { ...params, button: release.button },
    CALL_OPTIONS
  )
}

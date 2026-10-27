import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { getShortcutPlatform } from '@/hooks/useShortcutLabel'
import {
  firesNativePasteEvent,
  getClipboardEventText
} from '@/components/terminal-pane/terminal-clipboard-event-paste'
import { iterateBrowserTextInsertionChunks } from '../../../../../shared/browser-text-insertion-chunks'
import { assertClipboardTextWithinLimitWithYield } from '../../../../../shared/clipboard-text'
import { isEditableKeyboardTarget } from '../host-guest/browser-keyboard'
import {
  getRemoteBrowserKeyboardShortcut,
  getRemoteBrowserKeypressKey
} from './remote-browser-keyboard'
import { isRemoteBrowserPageMissingError } from './remote-browser-stream-errors'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type { RemoteBrowserOperationToken } from './remote-browser-stream-tokens'
import type {
  RemoteBrowserPaneNotice,
  RemoteBrowserRuntimeTarget
} from './remote-browser-page-input-model'

type RemoteKeyboardInput =
  | { method: 'browser.keypress'; key: string }
  | { method: 'browser.keyboardInsertText'; text: string }

export function useRemoteBrowserPageKeyboard({
  runtimeTarget,
  lifecycle,
  runtimeWorktree,
  enqueueRemoteInput,
  createRemoteOperationToken,
  isCurrentRemoteOperationToken,
  closeMissingRemotePage,
  scheduleRemoteTabInfoRefresh,
  setPaneNotice
}: {
  runtimeTarget: () => RemoteBrowserRuntimeTarget | null
  lifecycle: RemoteBrowserStreamLifecycle
  runtimeWorktree: string
  enqueueRemoteInput: (operation: () => Promise<void>) => Promise<void>
  createRemoteOperationToken: (remotePageId?: string | null) => RemoteBrowserOperationToken | null
  isCurrentRemoteOperationToken: (token: RemoteBrowserOperationToken) => boolean
  closeMissingRemotePage: (remotePageId?: string | null) => void
  scheduleRemoteTabInfoRefresh: (token: RemoteBrowserOperationToken, delayMs?: number) => void
  setPaneNotice: (notice: RemoteBrowserPaneNotice | null) => void
}): {
  handleRemoteScreenshotKeyDown: (event: React.KeyboardEvent<HTMLImageElement>) => void
  handleRemoteScreenshotPaste: (event: React.ClipboardEvent<HTMLImageElement>) => void
} {
  const enqueueRemoteKeyboardInput = (input: RemoteKeyboardInput): boolean => {
    const target = runtimeTarget()
    const pageId = lifecycle.tokens.remotePage
    const operationToken = pageId ? createRemoteOperationToken(pageId) : null
    if (!target || !pageId || !operationToken) {
      return false
    }
    const params = { worktree: runtimeWorktree, page: pageId }
    const rpcOptions = { timeoutMs: 15_000, suppressFeatureInteraction: true }
    setPaneNotice(null)
    enqueueRemoteInput(async () => {
      try {
        if (input.method === 'browser.keyboardInsertText') {
          await assertClipboardTextWithinLimitWithYield(input.text)
          // Why chunks: one request carrying a large paste would exceed the runtime socket's frame cap.
          for (const text of iterateBrowserTextInsertionChunks(input.text)) {
            if (!isCurrentRemoteOperationToken(operationToken)) {
              return
            }
            await callRuntimeRpc(
              target,
              'browser.keyboardInsertText',
              { ...params, text },
              rpcOptions
            )
          }
          return
        }
        if (!isCurrentRemoteOperationToken(operationToken)) {
          return
        }
        const { key } = input
        await callRuntimeRpc(target, 'browser.keypress', { ...params, key }, rpcOptions)
        if (
          key === 'Enter' ||
          key === 'Meta+r' ||
          key === 'Meta+Shift+r' ||
          key === 'Control+r' ||
          key === 'Control+Shift+r'
        ) {
          scheduleRemoteTabInfoRefresh(operationToken, 400)
        }
      } catch (error) {
        if (isCurrentRemoteOperationToken(operationToken)) {
          if (isRemoteBrowserPageMissingError(error)) {
            closeMissingRemotePage(pageId)
            return
          }
          setPaneNotice({
            kind: 'consequence',
            text: error instanceof Error ? error.message : 'Remote keyboard input failed.'
          })
        }
      }
    })
    return true
  }

  const handleRemoteScreenshotKeyDown = (event: React.KeyboardEvent<HTMLImageElement>): void => {
    if (isEditableKeyboardTarget(event.target)) {
      return
    }
    // Why: forwarding the chord would paste the host's clipboard; the native paste event carries ours.
    if (firesNativePasteEvent(event, getShortcutPlatform() === 'darwin')) {
      return
    }
    const key = getRemoteBrowserKeyboardShortcut(event) ?? getRemoteBrowserKeypressKey(event)
    if (key && enqueueRemoteKeyboardInput({ method: 'browser.keypress', key })) {
      event.preventDefault()
    }
  }

  const handleRemoteScreenshotPaste = (event: React.ClipboardEvent<HTMLImageElement>): void => {
    const text = getClipboardEventText(event.nativeEvent)
    if (text && enqueueRemoteKeyboardInput({ method: 'browser.keyboardInsertText', text })) {
      event.preventDefault()
    }
  }

  return { handleRemoteScreenshotKeyDown, handleRemoteScreenshotPaste }
}

import { useRef } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { getShortcutPlatform } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  getClipboardEventText,
  getNativeClipboardChordCommand
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
import {
  buildRemoteClipboardCommandExpression,
  buildRemoteCutDeleteExpression,
  readRemoteClipboardCommandResult,
  type RemoteBrowserClipboardChord,
  type RemoteBrowserClipboardCommand
} from './remote-browser-clipboard-command'
import type {
  RemoteBrowserPaneNotice,
  RemoteBrowserRuntimeTarget
} from './remote-browser-page-input-model'

type CopyWrite = { text: string }

type RemoteKeyboardInput =
  | { method: 'browser.keypress'; key: string }
  | { method: 'browser.keyboardInsertText'; text: string; copyWriteAtPaste: CopyWrite | null }
  | {
      method: 'clipboardCommand'
      command: RemoteBrowserClipboardCommand
      chord: RemoteBrowserClipboardChord
      fallbackKey: string
    }

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
  const lastCopyWriteRef = useRef<CopyWrite | null>(null)

  /** Returns the chord to forward when the page script cannot reach the focused frame. */
  const runClipboardCommand = async (
    input: Extract<RemoteKeyboardInput, { method: 'clipboardCommand' }>,
    target: RemoteBrowserRuntimeTarget,
    params: { worktree: string; page: string },
    operationToken: RemoteBrowserOperationToken
  ): Promise<string | null> => {
    const rpcOptions = { timeoutMs: 15_000, suppressFeatureInteraction: true }
    const cutId = createBrowserUuid()
    const expression = buildRemoteClipboardCommandExpression(input.command, input.chord, cutId)
    const { text, cutPending, forwardKeypress, tooLarge } = readRemoteClipboardCommandResult(
      await callRuntimeRpc(target, 'browser.eval', { ...params, expression }, rpcOptions)
    )
    if (forwardKeypress) {
      return input.fallbackKey
    }
    if (!isCurrentRemoteOperationToken(operationToken)) {
      return null
    }
    if (tooLarge) {
      setPaneNotice({
        kind: 'consequence',
        text: translate(
          'browser.remote.selectionTooLargeToCopy',
          'The selection is too large to copy from a page streamed from the remote host.'
        )
      })
      return null
    }
    if (!text) {
      return null
    }
    // Why: the terminal write is verified, so a cut never deletes text that missed the clipboard.
    await (cutPending
      ? window.api.ui.writeTerminalClipboardText(text)
      : window.api.ui.writeClipboardText(text))
    lastCopyWriteRef.current = { text }
    // Why: delete only once the text is on our clipboard, so a failed write never loses it.
    if (cutPending && isCurrentRemoteOperationToken(operationToken)) {
      const deleteExpression = buildRemoteCutDeleteExpression(cutId)
      await callRuntimeRpc(
        target,
        'browser.eval',
        { ...params, expression: deleteExpression },
        rpcOptions
      )
    }
    return null
  }

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
          // Why: a paste pressed before our queued copy finished carries the clipboard from before it.
          const lastCopyWrite = lastCopyWriteRef.current
          const pasteText =
            lastCopyWrite && lastCopyWrite !== input.copyWriteAtPaste
              ? lastCopyWrite.text
              : input.text
          await assertClipboardTextWithinLimitWithYield(pasteText)
          // Why chunks: one request carrying a large paste would exceed the runtime socket's frame cap.
          for (const text of iterateBrowserTextInsertionChunks(pasteText)) {
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
        const key =
          input.method === 'clipboardCommand'
            ? await runClipboardCommand(input, target, params, operationToken)
            : input.key
        if (!key) {
          return
        }
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
    const clipboardCommand = getNativeClipboardChordCommand(
      event,
      getShortcutPlatform() === 'darwin'
    )
    // Why: forwarding the chord would paste the host's clipboard; the native paste event carries ours.
    if (clipboardCommand === 'paste') {
      return
    }
    const shortcut = getRemoteBrowserKeyboardShortcut(event)
    // Why: forwarding copy or cut would fill the host's clipboard instead of ours.
    if (clipboardCommand && shortcut) {
      const { key, code, keyCode, which, metaKey, ctrlKey, altKey, shiftKey } = event
      // Why keyCode: xterm.js and other web terminals still read it for Ctrl+letter.
      const chord = { key, code, keyCode, which, metaKey, ctrlKey, altKey, shiftKey }
      if (
        enqueueRemoteKeyboardInput({
          method: 'clipboardCommand',
          command: clipboardCommand,
          chord,
          fallbackKey: shortcut
        })
      ) {
        event.preventDefault()
      }
      return
    }
    const key = shortcut ?? getRemoteBrowserKeypressKey(event)
    if (key && enqueueRemoteKeyboardInput({ method: 'browser.keypress', key })) {
      event.preventDefault()
    }
  }

  const handleRemoteScreenshotPaste = (event: React.ClipboardEvent<HTMLImageElement>): void => {
    const text = getClipboardEventText(event.nativeEvent)
    const copyWriteAtPaste = lastCopyWriteRef.current
    if (
      enqueueRemoteKeyboardInput({ method: 'browser.keyboardInsertText', text, copyWriteAtPaste })
    ) {
      event.preventDefault()
    }
  }

  return { handleRemoteScreenshotKeyDown, handleRemoteScreenshotPaste }
}

import { useRef } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { useTranslate } from '@/i18n/use-translate'
import {
  getClipboardEventText,
  getNativeClipboardChordCommand
} from '@/components/terminal-pane/clipboard/terminal-clipboard-event-paste'
import { iterateBrowserTextInsertionChunks } from '../../../../../shared/browser/automation/browser-text-insertion-chunks'
import { assertClipboardTextWithinLimitWithYield } from '../../../../../shared/clipboard/clipboard-text'
import { isEditableKeyboardTarget } from '../host-guest/input/browser-keyboard'
import { useAppStore } from '@/store'
import { keybindingMatchesAction } from '../../../../../shared/keybindings/matching'
import {
  getRemoteBrowserKeyboardShortcut,
  getRemoteBrowserKeypressKey,
  isRemoteBrowserProxyTextKey,
  takeRemoteBrowserProxyText
} from './remote-browser-keyboard'
import {
  isRemoteBrowserInputOpenedDialogError,
  isRemoteBrowserPageMissingError
} from './remote-browser-stream-errors'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type { RemoteBrowserOperationToken } from './remote-browser-stream-tokens'
import {
  buildRemoteExecCommandExpression,
  type RemoteBrowserClipboardChord,
  type RemoteBrowserClipboardCommand
} from './remote-browser-clipboard-command'
import { runRemoteClipboardCommand } from './run-remote-browser-clipboard-command'
import type {
  RemoteBrowserPaneNotice,
  RemoteBrowserRuntimeTarget
} from './remote-browser-page-input-model'
import type { BrowserPageEditCommand } from '../assemble-chrome/context-menu/browser-page-context-menu-items'

type CopyWrite = { text: string }

type RemoteKeyboardInput =
  | { method: 'browser.keypress'; key: string }
  /** Text the input method committed or the layout typed, which no key on the host types. */
  | { method: 'typedText'; text: string }
  | {
      method: 'browser.keyboardInsertText'
      /** Null reads this machine's clipboard in turn, as a menu Paste has no paste event. */
      text: string | null
      copyWriteAtPaste: CopyWrite | null
    }
  | {
      method: 'clipboardCommand'
      command: RemoteBrowserClipboardCommand
      chord: RemoteBrowserClipboardChord | null
      fallbackKey: string
    }
  | { method: 'execCommand'; command: 'undo' | 'redo' | 'selectAll' }

export function useRemoteBrowserPageKeyboard({
  pickerAvailable,
  runtimeTarget,
  lifecycle,
  runtimeWorktree,
  enqueueRemoteInput,
  createRemoteOperationToken,
  isCurrentRemoteOperationToken,
  closeMissingRemotePage,
  scheduleRemoteTabInfoRefresh,
  setPaneNotice,
  closeSelectPopupForPageInput
}: {
  pickerAvailable: boolean
  runtimeTarget: () => RemoteBrowserRuntimeTarget | null
  lifecycle: RemoteBrowserStreamLifecycle
  runtimeWorktree: string
  enqueueRemoteInput: (operation: () => Promise<void>) => Promise<void>
  createRemoteOperationToken: (remotePageId?: string | null) => RemoteBrowserOperationToken | null
  isCurrentRemoteOperationToken: (token: RemoteBrowserOperationToken) => boolean
  closeMissingRemotePage: (remotePageId?: string | null) => void
  scheduleRemoteTabInfoRefresh: (token: RemoteBrowserOperationToken, delayMs?: number) => void
  setPaneNotice: (notice: RemoteBrowserPaneNotice | null) => void
  closeSelectPopupForPageInput: () => void
}): {
  handleRemoteScreenshotKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  handleRemoteScreenshotPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void
  handleRemoteKeyboardProxyText: React.ReactEventHandler<HTMLTextAreaElement>
  runRemoteEditCommand: (command: BrowserPageEditCommand) => void
} {
  const t = useTranslate()
  const lastCopyWriteRef = useRef<CopyWrite | null>(null)

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
    const insertRemoteText = async (insertText: string): Promise<void> => {
      // Why chunks: one request carrying a large paste would exceed the runtime socket's frame cap.
      for (const text of iterateBrowserTextInsertionChunks(insertText)) {
        if (!isCurrentRemoteOperationToken(operationToken)) {
          return
        }
        await callRuntimeRpc(target, 'browser.keyboardInsertText', { ...params, text }, rpcOptions)
      }
    }
    enqueueRemoteInput(async () => {
      if (!isCurrentRemoteOperationToken(operationToken)) {
        return
      }
      closeSelectPopupForPageInput()
      try {
        if (input.method === 'typedText') {
          await insertRemoteText(input.text)
          return
        }
        if (input.method === 'browser.keyboardInsertText') {
          // Why: a paste pressed before our queued copy finished carries the clipboard from before it.
          const lastCopyWrite = lastCopyWriteRef.current
          const pasteText =
            lastCopyWrite && lastCopyWrite !== input.copyWriteAtPaste
              ? lastCopyWrite.text
              : (input.text ?? (await window.api.ui.readClipboardText()))
          await assertClipboardTextWithinLimitWithYield(pasteText)
          await insertRemoteText(pasteText)
          return
        }
        if (!isCurrentRemoteOperationToken(operationToken)) {
          return
        }
        if (input.method === 'execCommand') {
          const expression = buildRemoteExecCommandExpression(input.command)
          await callRuntimeRpc(target, 'browser.eval', { ...params, expression }, rpcOptions)
          return
        }
        const key =
          input.method === 'clipboardCommand'
            ? await runRemoteClipboardCommand({
                ...input,
                target,
                params,
                isCurrent: () => isCurrentRemoteOperationToken(operationToken),
                onTooLarge: () =>
                  setPaneNotice({
                    kind: 'consequence',
                    text: t(
                      'browser.remote.selectionTooLargeToCopy',
                      'The selection is too large to copy from a page streamed from the remote host.'
                    )
                  }),
                onCopied: (text) => {
                  lastCopyWriteRef.current = { text }
                }
              })
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
          if (isRemoteBrowserInputOpenedDialogError(error)) {
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

  const handleRemoteScreenshotKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Keys the input method composes with, and Option or AltGr characters, reach the proxy as text.
    if (isEditableKeyboardTarget(event.target) || isRemoteBrowserProxyTextKey(event.nativeEvent)) {
      return
    }
    // The annotate chord arms the picker here; typing it into the page too would double-act.
    if (
      pickerAvailable &&
      keybindingMatchesAction(
        'browser.annotateElement',
        event.nativeEvent,
        getShortcutPlatform(),
        useAppStore.getState().keybindings
      )
    ) {
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

  const handleRemoteKeyboardProxyText: React.ReactEventHandler<HTMLTextAreaElement> = (event) => {
    const text = takeRemoteBrowserProxyText(event)
    if (text) {
      enqueueRemoteKeyboardInput({ method: 'typedText', text })
    }
  }

  const handleRemoteScreenshotPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    // Why text only: markup and files would be staged in the page over several requests, and a page
    // that navigated meanwhile could receive them; they wait for a host-bound delivery.
    const text = getClipboardEventText(event.nativeEvent)
    const copyWriteAtPaste = lastCopyWriteRef.current
    if (
      enqueueRemoteKeyboardInput({ method: 'browser.keyboardInsertText', text, copyWriteAtPaste })
    ) {
      event.preventDefault()
    }
  }

  // The context menu's edit items: copy, cut and paste use this machine's clipboard, as the keys do.
  const runRemoteEditCommand = (command: BrowserPageEditCommand): void => {
    if (command === 'copy' || command === 'cut') {
      const key = command === 'copy' ? 'c' : 'x'
      enqueueRemoteKeyboardInput({
        method: 'clipboardCommand',
        command,
        chord: null,
        fallbackKey: `${getShortcutPlatform() === 'darwin' ? 'Meta' : 'Control'}+${key}`
      })
      return
    }
    if (command === 'paste' || command === 'pasteAndMatchStyle') {
      enqueueRemoteKeyboardInput({
        method: 'browser.keyboardInsertText',
        text: null,
        copyWriteAtPaste: lastCopyWriteRef.current
      })
      return
    }
    enqueueRemoteKeyboardInput({ method: 'execCommand', command })
  }

  return {
    handleRemoteScreenshotKeyDown,
    handleRemoteScreenshotPaste,
    handleRemoteKeyboardProxyText,
    runRemoteEditCommand
  }
}

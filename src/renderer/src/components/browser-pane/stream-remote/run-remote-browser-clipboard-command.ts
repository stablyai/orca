import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import {
  buildRemoteClipboardCommandExpression,
  buildRemoteCutDeleteExpression,
  readRemoteClipboardCommandResult,
  type RemoteBrowserClipboardChord,
  type RemoteBrowserClipboardCommand
} from './remote-browser-clipboard-command'
import type { RemoteBrowserRuntimeTarget } from './remote-browser-page-input-model'

/**
 * Copies or cuts in the streamed page onto this machine's clipboard. Returns the chord to forward
 * when the page script cannot reach the focused frame.
 */
export async function runRemoteClipboardCommand({
  command,
  chord,
  fallbackKey,
  target,
  params,
  isCurrent,
  onTooLarge,
  onCopied
}: {
  command: RemoteBrowserClipboardCommand
  chord: RemoteBrowserClipboardChord | null
  fallbackKey: string
  target: RemoteBrowserRuntimeTarget
  params: { worktree: string; page: string }
  isCurrent: () => boolean
  onTooLarge: () => void
  onCopied: (text: string) => void
}): Promise<string | null> {
  const rpcOptions = { timeoutMs: 15_000, suppressFeatureInteraction: true }
  const cutId = createBrowserUuid()
  const expression = buildRemoteClipboardCommandExpression(command, chord, cutId)
  const { text, cutPending, forwardKeypress, tooLarge } = readRemoteClipboardCommandResult(
    await callRuntimeRpc(target, 'browser.eval', { ...params, expression }, rpcOptions)
  )
  if (forwardKeypress) {
    return fallbackKey
  }
  if (!isCurrent()) {
    return null
  }
  if (tooLarge) {
    onTooLarge()
    return null
  }
  if (!text) {
    return null
  }
  // Why: the terminal write is verified, so a cut never deletes text that missed the clipboard.
  await (cutPending
    ? window.api.ui.writeTerminalClipboardText(text)
    : window.api.ui.writeClipboardText(text))
  onCopied(text)
  // Why: delete only once the text is on our clipboard, so a failed write never loses it.
  if (cutPending && isCurrent()) {
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

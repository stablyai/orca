import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { decodeBase64Bytes } from '@/lib/base64-bytes'
import {
  clipboardImageCopyErrorDescription,
  copyImageToClipboard,
  imageCopyFailedMessage
} from '@/lib/clipboard/images/clipboard-image-copy'
import { assertClipboardImageByteLengthWithinLimit } from '../../../../../shared/clipboard/clipboard-image'
import type { BrowserReadImageResult } from '../../../../../shared/browser/runtime/runtime-browser-contracts'
import type { BrowserPageContextMenuActions } from '../assemble-chrome/context-menu/browser-page-context-menu-items'
import { isRemoteBrowserPageMissingError } from './remote-browser-stream-errors'
import type {
  RemoteBrowserPaneNotice,
  RemoteBrowserRuntimeTarget
} from './remote-browser-page-input-model'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type { RemoteBrowserOperationToken } from './remote-browser-stream-tokens'
import type { RemoteBrowserPageContextMenuState } from './remote-browser-page-context-menu'

const RPC_OPTIONS = { timeoutMs: 15_000, suppressFeatureInteraction: true }

export type RemoteBrowserPageMenuActionDeps = {
  runtimeTarget: () => RemoteBrowserRuntimeTarget | null
  lifecycle: RemoteBrowserStreamLifecycle
  runtimeWorktree: string
  enqueueRemoteInput: (operation: () => Promise<void>) => Promise<void>
  createRemoteOperationToken: (remotePageId?: string | null) => RemoteBrowserOperationToken | null
  isCurrentRemoteOperationToken: (token: RemoteBrowserOperationToken) => boolean
  closeMissingRemotePage: (remotePageId?: string | null) => void
  setPaneNotice: (notice: RemoteBrowserPaneNotice | null) => void
}

async function readRemoteImage(
  target: RemoteBrowserRuntimeTarget,
  params: { worktree: string; page: string },
  url: string
): Promise<Blob> {
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let received = 0
  let mimeType = ''
  for (;;) {
    const chunk = await callRuntimeRpc<BrowserReadImageResult>(
      target,
      'browser.readImage',
      { ...params, url, offset: received },
      RPC_OPTIONS
    )
    // Check the whole size first so an oversized image is refused before it crosses the link.
    assertClipboardImageByteLengthWithinLimit(chunk.size)
    const bytes = decodeBase64Bytes(chunk.data)
    mimeType = chunk.mimeType
    received += bytes.length
    chunks.push(bytes)
    if (received >= chunk.size || bytes.length === 0) {
      return new Blob(chunks, { type: mimeType })
    }
  }
}

/** The spelling and image items of a streamed page's menu, run on the host that renders the page. */
export function remoteBrowserPageMenuActions(
  deps: RemoteBrowserPageMenuActionDeps,
  menu: RemoteBrowserPageContextMenuState
): Pick<
  BrowserPageContextMenuActions,
  'replaceMisspelling' | 'addWordToDictionary' | 'saveImage' | 'copyImage'
> {
  // A probed menu (older hosts) has no host commands behind these items.
  if (!menu.fromHost) {
    return {}
  }
  const imageUrl = menu.image?.url ?? null
  const run = (
    operation: (
      target: RemoteBrowserRuntimeTarget,
      params: { worktree: string; page: string }
    ) => Promise<void>,
    failure: (error: unknown) => string,
    queued = true
  ): void => {
    const target = deps.runtimeTarget()
    const pageId = deps.lifecycle.tokens.remotePage
    const token = pageId ? deps.createRemoteOperationToken(pageId) : null
    if (!target || !pageId || !token) {
      return
    }
    const attempt = async (): Promise<void> => {
      if (!deps.isCurrentRemoteOperationToken(token)) {
        return
      }
      try {
        await operation(target, { worktree: deps.runtimeWorktree, page: pageId })
      } catch (error) {
        if (!deps.isCurrentRemoteOperationToken(token)) {
          return
        }
        if (isRemoteBrowserPageMissingError(error)) {
          deps.closeMissingRemotePage(pageId)
          return
        }
        deps.setPaneNotice({ kind: 'direct', text: failure(error) })
      }
    }
    // Edits wait behind earlier input; a long image read must not hold up typing.
    void (queued ? deps.enqueueRemoteInput(attempt) : attempt())
  }
  const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)
  return {
    replaceMisspelling: (word) =>
      run(async (target, params) => {
        await callRuntimeRpc(target, 'browser.replaceMisspelling', { ...params, word }, RPC_OPTIONS)
      }, message),
    addWordToDictionary: (word) =>
      run(async (target, params) => {
        await callRuntimeRpc(
          target,
          'browser.addWordToDictionary',
          { ...params, word },
          RPC_OPTIONS
        )
      }, message),
    ...(imageUrl
      ? {
          saveImage: (url: string) =>
            run(async (target, params) => {
              await callRuntimeRpc(target, 'browser.saveImage', { ...params, url }, RPC_OPTIONS)
            }, message),
          copyImage: () =>
            run(
              async (target, params) => {
                await copyImageToClipboard(await readRemoteImage(target, params, imageUrl))
              },
              (error) => clipboardImageCopyErrorDescription(error) ?? imageCopyFailedMessage(),
              false
            )
        }
      : {})
  }
}

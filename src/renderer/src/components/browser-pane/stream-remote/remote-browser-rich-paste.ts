import { encodeBase64Bytes } from '@/lib/base64-bytes'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import type { RemoteBrowserRuntimeTarget } from './remote-browser-page-input-model'
import { CLIPBOARD_IMAGE_MAX_SOURCE_BYTES } from '../../../../../shared/clipboard/clipboard-image'
import { iterateBrowserTextInsertionChunks } from '../../../../../shared/browser/automation/browser-text-insertion-chunks'
import { measureUtf8ByteLength } from '../../../../../shared/text/utf8-byte-limits'
import { isRemoteBrowserPageMissingError } from './remote-browser-stream-errors'

/** What a paste carries beyond plain text; null when plain text is all there is. */
export type RemoteBrowserRichPaste = {
  text: string
  html: string
  files: File[]
}

const RPC_OPTIONS = { timeoutMs: 15_000, suppressFeatureInteraction: true }
const STAGED_PASTE_KEY = `Symbol.for('orca.remoteBrowserPaste')`
// Each staged part rides one eval request, which must fit a host's 768 KiB inbound frame once escaped.
const STAGE_REQUEST_BYTES = 640 * 1024
const STAGE_PART_BYTES = 512 * 1024
// JSON escapes a character into at most six, so a part this size always fits.
const ESCAPED_STAGE_PART_BYTES = Math.floor(STAGE_REQUEST_BYTES / 6)

export function readRemoteBrowserRichPaste(
  clipboardData: DataTransfer | null
): RemoteBrowserRichPaste | null {
  if (!clipboardData) {
    return null
  }
  const html = clipboardData.getData('text/html')
  const files = [...clipboardData.files]
  if (!html && files.length === 0) {
    return null
  }
  return { text: clipboardData.getData('text/plain'), html, files }
}

/**
 * Fires the page's paste event with the markup and files, as a native paste does. Returns whether
 * the page took it; when it didn't, the caller inserts the plain text.
 */
export async function pasteRemoteRichClipboard(
  paste: RemoteBrowserRichPaste,
  target: RemoteBrowserRuntimeTarget,
  params: { worktree: string; page: string },
  isCurrent: () => boolean
): Promise<boolean> {
  const evaluate = (expression: string): Promise<unknown> =>
    callRuntimeRpc(target, 'browser.eval', { ...params, expression }, RPC_OPTIONS)
  const expressions = await buildRemoteRichPasteExpressions(paste, createBrowserUuid())
  // Files past the clipboard limit go in as text only, rather than as a paste the host can't carry.
  if (!expressions) {
    return false
  }
  try {
    for (const expression of expressions.stage) {
      if (!isCurrent()) {
        return true
      }
      await evaluate(expression)
    }
    return isCurrent() ? readHandled(await evaluate(expressions.dispatch)) : true
  } catch (error) {
    // The page may refuse script (a crashed renderer, a paused debugger); the text still goes in.
    if (isRemoteBrowserPageMissingError(error)) {
      throw error
    }
    return false
  }
}

async function buildRemoteRichPasteExpressions(
  paste: RemoteBrowserRichPaste,
  pasteId: string
): Promise<{ stage: string[]; dispatch: string } | null> {
  const totalFileBytes = paste.files.reduce((sum, file) => sum + file.size, 0)
  if (totalFileBytes > CLIPBOARD_IMAGE_MAX_SOURCE_BYTES) {
    return null
  }
  const files = await Promise.all(
    paste.files.map(async (file) => ({
      name: file.name,
      type: file.type,
      data: encodeBase64Bytes(new Uint8Array(await file.arrayBuffer()))
    }))
  )
  const payload = JSON.stringify({ text: paste.text, html: paste.html, files })
  const stage: string[] = []
  const stagePart = (part: string): string => `(() => {
      const staged = window[${STAGED_PASTE_KEY}];
      if (!staged || staged.id !== ${JSON.stringify(pasteId)}) {
        window[${STAGED_PASTE_KEY}] = { id: ${JSON.stringify(pasteId)}, parts: [] };
      }
      window[${STAGED_PASTE_KEY}].parts.push(${JSON.stringify(part)});
    })()`
  // Base64 file data needs no escaping, so most parts go whole; markup that escapes heavily goes smaller.
  for (const part of iterateBrowserTextInsertionChunks(payload, STAGE_PART_BYTES)) {
    const expression = stagePart(part)
    if (!measureUtf8ByteLength(expression, { stopAfterBytes: STAGE_REQUEST_BYTES }).exceededLimit) {
      stage.push(expression)
      continue
    }
    for (const smaller of iterateBrowserTextInsertionChunks(part, ESCAPED_STAGE_PART_BYTES)) {
      stage.push(stagePart(smaller))
    }
  }
  return { stage, dispatch: buildDispatchExpression(pasteId) }
}

function buildDispatchExpression(pasteId: string): string {
  return `(() => {
    const staged = window[${STAGED_PASTE_KEY}];
    delete window[${STAGED_PASTE_KEY}];
    if (!staged || staged.id !== ${JSON.stringify(pasteId)}) {
      return JSON.stringify({ handled: false });
    }
    let doc = document;
    let target = doc.activeElement || doc.body;
    // Why: editors inside shadow roots or same-origin iframes hold the real focus.
    for (;;) {
      if (target.shadowRoot && target.shadowRoot.activeElement) {
        target = target.shadowRoot.activeElement;
      } else if (target.contentDocument && target.contentDocument.activeElement) {
        doc = target.contentDocument;
        target = doc.activeElement;
      } else {
        break;
      }
    }
    // A cross-origin frame's editor is out of reach; its text paste goes in through input instead.
    if (['IFRAME', 'FRAME', 'FENCEDFRAME', 'OBJECT', 'EMBED'].includes(target.tagName)) {
      return JSON.stringify({ handled: false });
    }
    const view = doc.defaultView;
    const payload = JSON.parse(staged.parts.join(''));
    const data = new view.DataTransfer();
    if (payload.text) data.setData('text/plain', payload.text);
    if (payload.html) data.setData('text/html', payload.html);
    for (const file of payload.files) {
      const binary = atob(file.data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      data.items.add(new view.File([bytes], file.name, { type: file.type }));
    }
    const event = new view.ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: data });
    // Like native paste, a page that handles the event (chat inputs, rich editors) inserts what it reads.
    return JSON.stringify({ handled: !target.dispatchEvent(event) });
  })()`
}

function readHandled(result: unknown): boolean {
  const raw = result && typeof result === 'object' && 'result' in result ? result.result : null
  try {
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : null
    return Boolean(parsed && typeof parsed === 'object' && 'handled' in parsed && parsed.handled)
  } catch {
    // An unreadable answer falls back to the plain-text paste.
    return false
  }
}

import { REMOTE_RPC_MAX_CONTENT_BYTES } from '../../../../../shared/remote-rpc-content-budget'

export type RemoteBrowserClipboardCommand = 'copy' | 'cut'

export type RemoteBrowserClipboardChord = Pick<
  KeyboardEventInit,
  'key' | 'code' | 'keyCode' | 'which' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
>

export type RemoteBrowserClipboardCommandResult = {
  text: string
  /** The cut waits for buildRemoteCutDeleteExpression to remove the copied selection. */
  cutPending: boolean
  /** Focus is in a frame the page script cannot reach. */
  forwardKeypress: boolean
  tooLarge: boolean
}

const PENDING_CUT_KEY = `Symbol.for('orca.remoteBrowserPendingCut')`
// Why: a reply over the runtime's frame budget fails, and over an E2EE channel closes the connection.
const MAX_REPLY_BYTES = REMOTE_RPC_MAX_CONTENT_BYTES - 64 * 1024

/** Runs copy or cut inside the streamed page and returns the text, leaving the host clipboard alone. */
export function buildRemoteClipboardCommandExpression(
  command: RemoteBrowserClipboardCommand,
  chord: RemoteBrowserClipboardChord,
  cutId: string
): string {
  return `(() => {
    let doc = document;
    let target = doc.activeElement || doc.body;
    // Why: editors inside shadow roots or same-origin iframes hold the real focus and selection.
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
    if (['IFRAME', 'FRAME', 'FENCEDFRAME', 'OBJECT', 'EMBED'].includes(target.tagName)) {
      return JSON.stringify({ forwardKeypress: true });
    }
    const view = doc.defaultView;
    const selection = doc.getSelection();
    const command = ${JSON.stringify(command)};
    const keyInit = { ...${JSON.stringify(chord)}, bubbles: true, cancelable: true, composed: true };
    const field = target instanceof view.HTMLInputElement || target instanceof view.HTMLTextAreaElement ? target : null;
    const hasFieldSelection = field && typeof field.selectionStart === 'number';
    const readSelection = () => hasFieldSelection
      ? field.value.slice(field.selectionStart, field.selectionEnd)
      : String(selection ?? '');
    const run = () => {
      // Like native input, a page that handles the keydown (e.g. Ctrl+C in a web terminal) cancels the copy.
      if (!target.dispatchEvent(new view.KeyboardEvent('keydown', keyInit))) {
        return {};
      }
      const clipboardData = new view.DataTransfer();
      const event = new view.ClipboardEvent(command, { bubbles: true, cancelable: true, composed: true, clipboardData });
      const selectionStart = !field && selection && !selection.isCollapsed ? selection.getRangeAt(0).startContainer : null;
      // Like native copy, the event goes to the element holding the selection start, not the focused body.
      const eventTarget = selectionStart
        ? (selectionStart.nodeType === 1 ? selectionStart : selectionStart.parentElement) || target
        : target;
      // Why: editors such as Monaco and CodeMirror supply their own text and do their own cut.
      if (!eventTarget.dispatchEvent(event)) {
        return { text: clipboardData.getData('text/plain') };
      }
      if (field && field.type === 'password') {
        return {};
      }
      const text = readSelection();
      if (command === 'copy') {
        return { text };
      }
      // Like native cut, only an editable selection is cut.
      if (!text || !doc.queryCommandEnabled('delete')) {
        return {};
      }
      const fieldStart = hasFieldSelection ? field.selectionStart : null;
      const fieldEnd = hasFieldSelection ? field.selectionEnd : null;
      const range = !hasFieldSelection && selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
      const isUnchanged = () => {
        if (target.getRootNode().activeElement !== target || readSelection() !== text) {
          return false;
        }
        if (hasFieldSelection) {
          return field.selectionStart === fieldStart && field.selectionEnd === fieldEnd;
        }
        return Boolean(range) && selection.rangeCount === 1 &&
          selection.getRangeAt(0).compareBoundaryPoints(view.Range.START_TO_START, range) === 0 &&
          selection.getRangeAt(0).compareBoundaryPoints(view.Range.END_TO_END, range) === 0;
      };
      // Why: the page may change focus or the selection while the text travels to our clipboard.
      window[${PENDING_CUT_KEY}] = { id: ${JSON.stringify(cutId)}, finish: () => {
        // Delete keeps the page's undo history.
        if (isUnchanged()) {
          doc.execCommand('delete');
        }
      } };
      return { text, cutPending: true };
    };
    delete window[${PENDING_CUT_KEY}];
    const result = run();
    target.dispatchEvent(new view.KeyboardEvent('keyup', keyInit));
    const serialized = JSON.stringify(result);
    // Each code unit encodes to at most 6 bytes, so only near-limit replies need measuring.
    const mayBeTooLarge = (serialized.length + location.href.length) * 6 > ${MAX_REPLY_BYTES};
    if (mayBeTooLarge && new TextEncoder().encode(JSON.stringify({ result: serialized, origin: location.href })).length > ${MAX_REPLY_BYTES}) {
      delete window[${PENDING_CUT_KEY}];
      return JSON.stringify({ tooLarge: true });
    }
    return serialized;
  })()`
}

/** Finishes a cut once its text is on the local clipboard. */
export function buildRemoteCutDeleteExpression(cutId: string): string {
  return `(() => {
    const cut = window[${PENDING_CUT_KEY}];
    // Why: another viewer of this page may have started its own cut since.
    if (cut && cut.id === ${JSON.stringify(cutId)}) {
      delete window[${PENDING_CUT_KEY}];
      cut.finish();
    }
  })()`
}

export function readRemoteClipboardCommandResult(
  result: unknown
): RemoteBrowserClipboardCommandResult {
  const empty = { text: '', cutPending: false, forwardKeypress: false, tooLarge: false }
  const raw = result && typeof result === 'object' && 'result' in result ? result.result : null
  if (typeof raw !== 'string') {
    return empty
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return empty
    }
    return {
      text: 'text' in parsed && typeof parsed.text === 'string' ? parsed.text : '',
      cutPending: 'cutPending' in parsed && parsed.cutPending === true,
      forwardKeypress: 'forwardKeypress' in parsed && parsed.forwardKeypress === true,
      tooLarge: 'tooLarge' in parsed && parsed.tooLarge === true
    }
  } catch {
    return empty
  }
}

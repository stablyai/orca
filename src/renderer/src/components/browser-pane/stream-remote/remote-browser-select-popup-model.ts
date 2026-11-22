import { z } from 'zod'
import { readRemoteBrowserEvalJson } from './remote-browser-page-input-model'

// Why: a <select>'s option list is a browser widget outside the page's compositor surface, so
// the screencast never shows it. The pane draws the list itself from what the page reports.

const MAX_SELECT_POPUP_OPTIONS = 2_000
const MAX_SELECT_POPUP_LABEL_LENGTH = 500
// The read leaves the opened <select> here so the choice acts on that element, not on whatever has focus.
const OPENED_SELECT_KEY = `Symbol.for('orca.remote-browser-opened-select')`

// Walks to the focused element through shadow roots and same-origin frames, adding each frame's
// content offset so the rect is in top-level viewport CSS pixels.
const FIND_FOCUSED_SELECT = `
  let el = document.activeElement, offsetX = 0, offsetY = 0;
  for (let depth = 0; el && depth < 32; depth++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
    if (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME') { break; }
    let inner = null;
    try { inner = el.contentDocument; } catch { inner = null; }
    if (!inner || !inner.activeElement) { el = null; break; }
    const frameRect = el.getBoundingClientRect();
    const frameStyle = getComputedStyle(el);
    offsetX += frameRect.left + el.clientLeft + (parseFloat(frameStyle.paddingLeft) || 0);
    offsetY += frameRect.top + el.clientTop + (parseFloat(frameStyle.paddingTop) || 0);
    el = inner.activeElement;
  }
  const select = el && el.tagName === 'SELECT' ? el : null;`

/** Reads the open <select> list the last press opened, and closes the host's invisible copy. */
export const REMOTE_OPEN_SELECT_POPUP_EXPRESSION = `(() => {${FIND_FOCUSED_SELECT}
  if (!select) { return null; }
  let open = false;
  try { open = select.matches(':open'); } catch { return null; }
  // A customizable picker (::picker(select) set to base-select) draws in the page, so the frame shows it.
  if (!open || getComputedStyle(select, '::picker(select)').appearance === 'base-select') { return null; }
  window[${OPENED_SELECT_KEY}] = new WeakRef(select);
  // Why: the host's list would stay open unseen and take a later click; blurring closes it.
  select.blur();
  select.focus({ preventScroll: true });
  const rect = select.getBoundingClientRect();
  const hiddenGroups = new Map();
  const isHiddenGroup = (group) => {
    if (!hiddenGroups.has(group)) { hiddenGroups.set(group, group.hidden || getComputedStyle(group).display === 'none'); }
    return hiddenGroups.get(group);
  };
  const options = Array.from(select.options).slice(0, ${MAX_SELECT_POPUP_OPTIONS}).map((option) => {
    const group = option.parentElement && option.parentElement.tagName === 'OPTGROUP' ? option.parentElement : null;
    return {
      label: option.label.slice(0, ${MAX_SELECT_POPUP_LABEL_LENGTH}),
      disabled: option.disabled || Boolean(group && group.disabled),
      hidden: option.hidden || getComputedStyle(option).display === 'none' || Boolean(group && isHiddenGroup(group)),
      group: group ? group.label.slice(0, ${MAX_SELECT_POPUP_LABEL_LENGTH}) : null
    };
  });
  return JSON.stringify({
    rect: { x: offsetX + rect.left, y: offsetY + rect.top, width: rect.width, height: rect.height },
    selectedIndex: select.selectedIndex,
    optionCount: select.options.length,
    options
  });
})()`

/** Picks an option the way the native list does: input then change, only when the value moves. */
export function buildRemoteSelectOptionChoiceExpression(choice: {
  index: number
  optionCount: number
  label: string
}): string {
  return `(() => {
  const opened = window[${OPENED_SELECT_KEY}];
  const select = opened ? opened.deref() : null;
  const option = select ? select.options[${JSON.stringify(choice.index)}] : null;
  const group = option && option.parentElement && option.parentElement.tagName === 'OPTGROUP' ? option.parentElement : null;
  // The page changed the select while the picker was open; choosing could hit the wrong option.
  if (!option || !select.isConnected || select.disabled || select.options.length !== ${JSON.stringify(choice.optionCount)} || option.disabled || (group && group.disabled) || option.label.slice(0, ${MAX_SELECT_POPUP_LABEL_LENGTH}) !== ${JSON.stringify(choice.label)}) {
    return 'stale';
  }
  if (select.selectedIndex === option.index) { return 'unchanged'; }
  select.selectedIndex = option.index;
  select.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return 'chosen';
})()`
}

const RemoteSelectPopupResult = z.object({
  rect: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number()
  }),
  selectedIndex: z.number().int(),
  optionCount: z.number().int().nonnegative(),
  options: z.array(
    z.object({
      label: z.string(),
      disabled: z.boolean(),
      hidden: z.boolean(),
      group: z.string().nullable()
    })
  )
})

export type RemoteSelectPopup = z.infer<typeof RemoteSelectPopupResult>

export function readRemoteSelectPopupResult(result: unknown): RemoteSelectPopup | null {
  const parsed = RemoteSelectPopupResult.safeParse(readRemoteBrowserEvalJson(result))
  return parsed.success ? parsed.data : null
}

export type RemoteSelectPopupGroup = {
  label: string | null
  options: { index: number; label: string; disabled: boolean }[]
}

/** Runs of options under one <optgroup>, in page order; hidden options are not listed, as natively. */
export function groupRemoteSelectPopupOptions(
  options: RemoteSelectPopup['options']
): RemoteSelectPopupGroup[] {
  const groups: RemoteSelectPopupGroup[] = []
  options.forEach((option, index) => {
    if (option.hidden) {
      return
    }
    const last = groups.at(-1)
    const entry = { index, label: option.label, disabled: option.disabled }
    if (last && last.label === option.group) {
      last.options.push(entry)
    } else {
      groups.push({ label: option.group, options: [entry] })
    }
  })
  return groups
}

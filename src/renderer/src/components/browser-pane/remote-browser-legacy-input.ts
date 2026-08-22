type LegacyKeypress = {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

function parseLegacyKeypress(serializedKey: string): LegacyKeypress {
  const modifiers = new Set<string>()
  let key = serializedKey
  for (;;) {
    const match = /^(Alt|Control|Meta|Shift)\+/.exec(key)
    if (!match) {
      break
    }
    modifiers.add(match[1])
    key = key.slice(match[0].length)
  }
  return {
    key: key === 'Space' ? ' ' : key,
    altKey: modifiers.has('Alt'),
    ctrlKey: modifiers.has('Control'),
    metaKey: modifiers.has('Meta'),
    shiftKey: modifiers.has('Shift')
  }
}

export function buildLegacyRemoteBrowserWheelExpression(
  x: number,
  y: number,
  dx: number,
  dy: number
): string {
  const input = JSON.stringify({ x, y, dx, dy })
  return `(() => {
    const input = ${input};
    const source = document.elementFromPoint(input.x, input.y);
    const wheel = new WheelEvent('wheel', { deltaX: input.dx, deltaY: input.dy, clientX: input.x, clientY: input.y, bubbles: true, cancelable: true, view: window });
    if (source && !source.dispatchEvent(wheel)) return { prevented: true };
    let target = source;
    const scrollable = (element) => {
      if (!(element instanceof Element)) return false;
      const style = getComputedStyle(element);
      return ((/(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight) || (/(auto|scroll|overlay)/.test(style.overflowX) && element.scrollWidth > element.clientWidth));
    };
    while (target && !scrollable(target)) target = target.parentElement;
    const destination = target || document.scrollingElement || document.documentElement;
    destination.scrollBy({ left: input.dx, top: input.dy, behavior: 'instant' });
    return { x: destination.scrollLeft, y: destination.scrollTop };
  })()`
}

export function buildLegacyRemoteBrowserHistoryExpression(direction: 'back' | 'forward'): string {
  return `(() => {
    setTimeout(() => history.${direction}(), 0);
    return { scheduled: ${JSON.stringify(direction)}, url: location.href };
  })()`
}

export function buildLegacyRemoteBrowserKeypressExpression(serializedKey: string): string | null {
  const input = parseLegacyKeypress(serializedKey)
  const shortcut = input.altKey || input.ctrlKey || input.metaKey
  const lowerKey = input.key.toLowerCase()
  if (shortcut && lowerKey !== 'r' && lowerKey !== 'a') {
    return null
  }

  return `(() => {
    const input = ${JSON.stringify(input)};
    const target = document.activeElement;
    const init = { key: input.key, altKey: input.altKey, ctrlKey: input.ctrlKey, metaKey: input.metaKey, shiftKey: input.shiftKey, bubbles: true, cancelable: true };
    if (target && !target.dispatchEvent(new KeyboardEvent('keydown', init))) {
      target.dispatchEvent(new KeyboardEvent('keyup', init));
      return { handled: 'page' };
    }
    const mutableControl = (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && !target.disabled && !target.readOnly;
    const selectionEditable = mutableControl && (target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && /^(text|search|tel|url|password)$/i.test(target.type)));
    const valueEditable = mutableControl && target instanceof HTMLInputElement && /^(date|datetime-local|email|month|number|time|week)$/i.test(target.type);
    const editable = selectionEditable || valueEditable;
    const rich = target instanceof HTMLElement && target.isContentEditable;
    const valueSelectionKey = Symbol.for('orca.legacy.value-selection');
    const readValueSelection = () => {
      const saved = target[valueSelectionKey];
      if (saved?.value === target.value) return saved;
      return { start: target.value.length, end: target.value.length, direction: 'none', value: target.value };
    };
    const writeValueSelection = (start, end, direction = 'none') => {
      target[valueSelectionKey] = { start, end, direction, value: target.value };
    };
    const emitInput = (inputType, data = null) => target.dispatchEvent(new InputEvent('input', { inputType, data, bubbles: true }));
    const replaceSelection = (text, inputType) => {
      if (selectionEditable) {
        const start = target.selectionStart ?? target.value.length;
        const end = target.selectionEnd ?? start;
        target.setRangeText(text, start, end, 'end');
      } else {
        const selection = readValueSelection();
        target.value = target.value.slice(0, selection.start) + text + target.value.slice(selection.end);
        const position = selection.start + text.length;
        writeValueSelection(position, position);
      }
      emitInput(inputType, text);
    };
    const moveCaret = (position, extend = false) => {
      if (valueEditable) {
        const selection = readValueSelection();
        if (!extend) {
          writeValueSelection(position, position);
          return;
        }
        const anchor = selection.direction === 'backward' ? selection.end : selection.start;
        writeValueSelection(Math.min(anchor, position), Math.max(anchor, position), position < anchor ? 'backward' : 'forward');
        return;
      }
      if (!extend) {
        target.setSelectionRange(position, position);
        return;
      }
      const anchor = target.selectionDirection === 'backward' ? (target.selectionEnd ?? 0) : (target.selectionStart ?? 0);
      target.setSelectionRange(Math.min(anchor, position), Math.max(anchor, position), position < anchor ? 'backward' : 'forward');
    };
    const finish = (handled) => {
      if (target) target.dispatchEvent(new KeyboardEvent('keyup', init));
      return { handled };
    };
    if (target && (input.key.length === 1 || input.key === 'Enter') && !target.dispatchEvent(new KeyboardEvent('keypress', init))) {
      return finish('page');
    }
    const shortcut = input.altKey || input.ctrlKey || input.metaKey;
    if (shortcut && input.key.toLowerCase() === 'r') {
      setTimeout(() => location.reload(), 0);
      return finish('reload');
    }
    if (shortcut && input.key.toLowerCase() === 'a' && (editable || rich)) {
      if (selectionEditable) target.select();
      else if (valueEditable) writeValueSelection(0, target.value.length, 'forward');
      else {
        const range = document.createRange();
        range.selectNodeContents(target);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      return finish('select-all');
    }
    if (input.key.length === 1 && !shortcut) {
      if (editable) replaceSelection(input.key, 'insertText');
      else if (rich) document.execCommand('insertText', false, input.key);
      else if (input.key === ' ' && target instanceof HTMLElement) target.click();
      return finish('text');
    }
    if (input.key === 'Tab') {
      const focusable = [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')].filter((element) => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length > 0);
      const current = focusable.indexOf(target);
      const offset = input.shiftKey ? -1 : 1;
      const next = focusable[(current + offset + focusable.length) % focusable.length];
      next?.focus();
      return finish('focus');
    }
    if (input.key === 'Enter') {
      if (target instanceof HTMLTextAreaElement) {
        if (selectionEditable) replaceSelection('\\n', 'insertLineBreak');
        return finish('enter');
      }
      else if (rich) document.execCommand('insertParagraph');
      else if (target instanceof HTMLInputElement && target.form) target.form.requestSubmit();
      else if (target instanceof HTMLElement) target.click();
      return finish('enter');
    }
    if (editable && (input.key === 'Backspace' || input.key === 'Delete')) {
      const selection = valueEditable ? readValueSelection() : null;
      let start = selection?.start ?? target.selectionStart ?? 0;
      let end = selection?.end ?? target.selectionEnd ?? start;
      if (start === end && input.key === 'Backspace') start = Math.max(0, start - 1);
      if (start === end && input.key === 'Delete') end = Math.min(target.value.length, end + 1);
      if (selectionEditable) target.setRangeText('', start, end, 'end');
      else {
        target.value = target.value.slice(0, start) + target.value.slice(end);
        writeValueSelection(start, start);
      }
      emitInput(input.key === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward');
      return finish('delete');
    }
    if (rich && (input.key === 'Backspace' || input.key === 'Delete')) {
      document.execCommand(input.key === 'Backspace' ? 'delete' : 'forwardDelete');
      return finish('delete');
    }
    if (editable && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(input.key)) {
      const selection = valueEditable ? readValueSelection() : null;
      const direction = selection?.direction ?? target.selectionDirection;
      const current = direction === 'backward' ? (selection?.start ?? target.selectionStart ?? 0) : (selection?.end ?? target.selectionEnd ?? 0);
      const position = input.key === 'Home' ? 0 : input.key === 'End' ? target.value.length : input.key === 'ArrowLeft' ? Math.max(0, current - 1) : Math.min(target.value.length, current + 1);
      moveCaret(position, input.shiftKey);
      return finish('caret');
    }
    if (rich && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(input.key)) {
      const selection = window.getSelection();
      const direction = input.key === 'ArrowLeft' || input.key === 'Home' ? 'backward' : 'forward';
      const granularity = input.key === 'Home' || input.key === 'End' ? 'lineboundary' : 'character';
      selection?.modify(input.shiftKey ? 'extend' : 'move', direction, granularity);
      return finish('caret');
    }
    const viewportStep = Math.max(1, window.innerHeight * 0.8);
    if (input.key === 'PageUp') window.scrollBy(0, -viewportStep);
    else if (input.key === 'PageDown' || input.key === ' ') window.scrollBy(0, viewportStep);
    else if (input.key === 'ArrowUp') window.scrollBy(0, -40);
    else if (input.key === 'ArrowDown') window.scrollBy(0, 40);
    else if (input.key === 'Home') window.scrollTo(0, 0);
    else if (input.key === 'End') window.scrollTo(0, document.documentElement.scrollHeight);
    else if (input.key === 'Escape' && target instanceof HTMLElement) target.blur();
    return finish('key');
  })()`
}

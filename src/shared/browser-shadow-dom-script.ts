// Shared source is evaluated separately in the guest and isolated viewport worlds.
export const BROWSER_SHADOW_DOM_SCRIPT = `
  function shadowComposedParent(element) {
    if (element.assignedSlot) return element.assignedSlot;
    if (element.parentElement) return element.parentElement;
    var root = element.getRootNode();
    return root && root.host || null;
  }

  function shadowSelectionRoots(element) {
    var roots = [];
    var seen = new Set();
    while (element) {
      if (seen.has(element)) break;
      seen.add(element);
      var root = element.getRootNode();
      if (root && root.host && roots.indexOf(root) === -1) roots.push(root);
      element = shadowComposedParent(element);
    }
    return roots;
  }

  function shadowElementFromPoint(x, y) {
    var element = document.elementFromPoint(x, y);
    var seen = new Set();
    for (var depth = 0; element && depth < 32; depth++) {
      var root = element.shadowRoot;
      if (!root || seen.has(root) || typeof root.elementFromPoint !== 'function') break;
      seen.add(root);
      var next = root.elementFromPoint(x, y);
      if (!next || next === element) break;
      element = next;
    }
    return element;
  }

  function shadowFindSelected(attribute, value) {
    var selected = null;
    var candidates = document.querySelectorAll('[' + attribute + ']');
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].getAttribute(attribute) !== value) continue;
      if (selected) return null;
      selected = candidates[i];
    }
    var lightSelected = selected;
    // Native document queries preserve large light DOMs; only shadow traversal is bounded.
    var stack = [];
    var elements = document.querySelectorAll('*');
    for (var i = 0; i < elements.length; i++) {
      var root = elements[i].shadowRoot;
      if (root && root.firstElementChild) stack.push(root.firstElementChild);
    }
    var inspected = 0;
    while (stack.length && inspected < 10000) {
      var element = stack.pop();
      if (!element) continue;
      inspected++;
      if (element.getAttribute(attribute) === value) {
        if (selected) return null;
        selected = element;
      }
      if (element.nextElementSibling) stack.push(element.nextElementSibling);
      if (element.firstElementChild) stack.push(element.firstElementChild);
      if (element.shadowRoot && element.shadowRoot.firstElementChild) {
        stack.push(element.shadowRoot.firstElementChild);
      }
    }
    // An incomplete shadow scan cannot prove uniqueness, so it keeps the light-DOM result.
    return stack.length ? lightSelected : selected;
  }
`

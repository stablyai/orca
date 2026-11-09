// Why: page-named form controls (e.g. <form name="host">) shadow DOM properties in the page's
// world, so each value is type-checked before the walk follows it.
export const COMPOSED_TREE_SCRIPT = `  function composedParent(element) {
    var slot = element.assignedSlot;
    if (slot && slot.localName === 'slot') return slot;
    var parent = element.parentNode;
    if (parent && parent.nodeType === 11) return parent.host || null;
    return parent && parent.nodeType === 1 ? parent : null;
  }

  // Scroll events don't leave a shadow root, so trackers listen on each open root above the target.
  function shadowRootsAbove(element) {
    var roots = [];
    for (var node = element; node; node = composedParent(node)) {
      var parent = node.parentNode;
      if (parent && parent.nodeType === 11 && parent.host) roots.push(parent);
    }
    return roots;
  }
`

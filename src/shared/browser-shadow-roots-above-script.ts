// Why: scroll events don't leave a shadow root, so trackers listen on each open root in the
// target's composed ancestry, including roots it is slotted into.
export const SHADOW_ROOTS_ABOVE_SCRIPT = `  function shadowRootsAbove(element) {
    var roots = [];
    for (var node = element; node; node = node.assignedSlot || node.parentNode || node.host) {
      if (node.nodeType === 11 && node.host) roots.push(node);
    }
    return roots;
  }
`

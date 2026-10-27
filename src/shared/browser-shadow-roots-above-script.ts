// Why: scroll events don't leave a shadow root, so trackers listen on each open root above the target.
export const SHADOW_ROOTS_ABOVE_SCRIPT = `  function shadowRootsAbove(element) {
    var roots = [];
    for (var root = element.getRootNode(); root.nodeType === 11 && root.host; root = root.host.getRootNode()) {
      roots.push(root);
    }
    return roots;
  }
`

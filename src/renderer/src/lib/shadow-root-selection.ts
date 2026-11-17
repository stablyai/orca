function supportsShadowSelection(
  root: ShadowRoot
): root is ShadowRoot & { getSelection(): Selection | null } {
  return 'getSelection' in root && typeof root.getSelection === 'function'
}

export function getShadowRootSelection(root: ShadowRoot | null | undefined): Selection | null {
  return root && supportsShadowSelection(root) ? root.getSelection() : null
}

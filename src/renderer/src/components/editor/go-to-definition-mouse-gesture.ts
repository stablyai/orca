type GoToDefinitionMouseGesture = {
  platform: NodeJS.Platform
  metaKey: boolean
  ctrlKey: boolean
  leftButton: boolean
  contentText: boolean
  hasPosition: boolean
}

export function isGoToDefinitionMouseGesture(gesture: GoToDefinitionMouseGesture): boolean {
  const modifierPressed = gesture.platform === 'darwin' ? gesture.metaKey : gesture.ctrlKey
  return modifierPressed && gesture.leftButton && gesture.contentText && gesture.hasPosition
}

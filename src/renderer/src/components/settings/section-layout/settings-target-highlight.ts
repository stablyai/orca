export const SETTINGS_TARGET_HIGHLIGHT_CLASS_NAME = 'settings-target-highlight'

const SETTINGS_TITLE_TARGET_PREFIX = 'settings-title:'

// Search entries without an anchor id target their rendered row by title.
export function getSettingsTitleTargetId(title: string): string {
  return `${SETTINGS_TITLE_TARGET_PREFIX}${title}`
}

export function parseSettingsTitleTargetId(targetId: string): string | null {
  return targetId.startsWith(SETTINGS_TITLE_TARGET_PREFIX)
    ? targetId.slice(SETTINGS_TITLE_TARGET_PREFIX.length)
    : null
}

// Settings cards pad differently (groups, sections, shadcn cards, accordions), so measure the
// gap from the row to its nearest card's inner edges instead of assuming one gutter.
function findEnclosingSettingsCard(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (
      Number.parseFloat(style.borderLeftWidth) > 0 &&
      Number.parseFloat(style.borderTopLeftRadius) >= 8
    ) {
      return node
    }
  }
  return null
}

export function applySettingsTargetHighlightBleed(target: HTMLElement): void {
  const card = findEnclosingSettingsCard(target)
  if (!card) {
    return
  }
  const cardRect = card.getBoundingClientRect()
  const cardStyle = getComputedStyle(card)
  const targetRect = target.getBoundingClientRect()
  const left = targetRect.left - cardRect.left - Number.parseFloat(cardStyle.borderLeftWidth)
  const right = cardRect.right - Number.parseFloat(cardStyle.borderRightWidth) - targetRect.right
  target.style.setProperty('--settings-target-bleed-left', `${Math.max(0, left)}px`)
  target.style.setProperty('--settings-target-bleed-right', `${Math.max(0, right)}px`)
}

export function clearSettingsTargetHighlightBleed(target: HTMLElement): void {
  target.style.removeProperty('--settings-target-bleed-left')
  target.style.removeProperty('--settings-target-bleed-right')
}

import { ChevronRight } from 'lucide-react'
import type { BrowserExtensionMenuItem } from '../../../../../shared/browser-guest-events'

/** The page's chrome.contextMenus entries; main runs the picked one. */
export function BrowserExtensionMenuItems({
  browserPageId,
  items,
  itemClassName,
  onPicked
}: {
  browserPageId: string
  items: BrowserExtensionMenuItem[]
  itemClassName: string
  onPicked: () => void
}): React.JSX.Element | null {
  if (items.length === 0) {
    return null
  }
  return (
    <>
      {items.map((item) => (
        <button
          key={item.index}
          role="menuitem"
          disabled={!item.enabled}
          className={itemClassName}
          onClick={() => {
            window.api.browser.runExtensionMenuItem({ browserPageId, index: item.index })
            onPicked()
          }}
        >
          {item.iconDataUrl ? <img src={item.iconDataUrl} alt="" className="size-4" /> : null}
          <span className="flex-1 text-left">{item.label}</span>
          {item.hasSubmenu ? <ChevronRight className="size-3.5 opacity-60" /> : null}
        </button>
      ))}
      <div className="my-1 h-px bg-border/70" />
    </>
  )
}

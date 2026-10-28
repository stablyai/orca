import { useState } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  BrowserExtensionContextMenuItem,
  BrowserExtensionContextMenuPayload
} from '../../../../../shared/browser-extension-context-menu-types'

type ItemProps = {
  item: BrowserExtensionContextMenuItem
  extensionId: string
  token: string
  itemClassName: string
  onDone: () => void
}

const ITEM_SELECTOR = '[role^="menuitem"]:not(:disabled)'

/** Arrow keys inside one submenu panel: its own items only, not nested panels'. */
function focusSibling(panel: HTMLElement, step: 1 | -1): void {
  const items = [...panel.children].flatMap((child) => {
    const item = child.matches(ITEM_SELECTOR)
      ? child
      : child.querySelector(`:scope > ${ITEM_SELECTOR}`)
    return item instanceof HTMLElement ? [item] : []
  })
  const active = document.activeElement
  const index = active instanceof HTMLElement ? items.indexOf(active) : -1
  items[(index + step + items.length) % items.length]?.focus()
}

function ExtensionMenuItem({
  item,
  extensionId,
  token,
  itemClassName,
  onDone
}: ItemProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  if (item.type === 'separator') {
    return <div className="my-1 h-px bg-border/70" />
  }
  if (item.children.length > 0) {
    return (
      <div>
        <button
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={!item.enabled}
          className={itemClassName}
          onClick={() => setOpen((value) => !value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'Enter') {
              event.preventDefault()
              event.stopPropagation()
              setOpen(true)
              const wrapper = event.currentTarget.parentElement
              requestAnimationFrame(() => {
                wrapper?.querySelector<HTMLElement>(`[role="menu"] ${ITEM_SELECTOR}`)?.focus()
              })
            }
          }}
        >
          <span className="flex-1 truncate text-left">{item.title}</span>
          <ChevronRight className="size-3.5 opacity-60" />
        </button>
        {open ? (
          <div
            role="menu"
            aria-orientation="vertical"
            // Why in place: the page menu scrolls, which would clip a panel opened beside it.
            className="ml-3 border-l border-border/70 pl-1"
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                event.stopPropagation()
                focusSibling(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1)
              } else if (event.key === 'ArrowLeft') {
                event.preventDefault()
                event.stopPropagation()
                setOpen(false)
                event.currentTarget.parentElement
                  ?.querySelector<HTMLElement>(':scope > [role="menuitem"]')
                  ?.focus()
              }
            }}
          >
            {item.children.map((child) => (
              <ExtensionMenuItem
                key={child.key}
                item={child}
                extensionId={extensionId}
                token={token}
                itemClassName={itemClassName}
                onDone={onDone}
              />
            ))}
          </div>
        ) : null}
      </div>
    )
  }
  const checkable = item.type === 'checkbox' || item.type === 'radio'
  return (
    <button
      role={checkable ? (item.type === 'radio' ? 'menuitemradio' : 'menuitemcheckbox') : 'menuitem'}
      aria-checked={checkable ? item.checked : undefined}
      disabled={!item.enabled || !item.key}
      className={itemClassName}
      onClick={() => {
        void window.api.browser.extensionsContextMenuClick({ token, extensionId, key: item.key })
        onDone()
      }}
    >
      {checkable ? <Check className={cn('size-3.5', !item.checked && 'opacity-0')} /> : null}
      <span className="flex-1 truncate text-left">{item.title}</span>
    </button>
  )
}

/** Extension entries in the page context menu, grouped by extension as main arranged them. */
export function BrowserPageExtensionMenuItems({
  menu,
  itemClassName,
  onDone
}: {
  menu: BrowserExtensionContextMenuPayload
  itemClassName: string
  onDone: () => void
}): React.JSX.Element {
  return (
    <>
      {menu.groups.map((group) =>
        group.items.map((item) => (
          <ExtensionMenuItem
            key={`${group.extensionId}:${item.key}`}
            item={item}
            extensionId={group.extensionId}
            token={menu.token}
            itemClassName={itemClassName}
            onDone={onDone}
          />
        ))
      )}
    </>
  )
}

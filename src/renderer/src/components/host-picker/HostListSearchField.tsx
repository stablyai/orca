import { useRef } from 'react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { searchHostsLabel } from './host-picker-copy'

const MENU_ITEM_SELECTOR = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'

function focusAdjacentMenuItem(from: HTMLElement, step: 1 | -1): void {
  const menu = from.closest('[role="menu"]')
  const item = from.closest<HTMLElement>(MENU_ITEM_SELECTOR)
  if (!menu || !item) {
    return
  }
  const items = Array.from(menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)).filter(
    (candidate) => !candidate.hasAttribute('data-disabled')
  )
  items[items.indexOf(item) + step]?.focus()
}

function HostListSearchInput({
  value,
  onChange,
  inputRef,
  onKeyDown
}: {
  value: string
  onChange: (value: string) => void
  inputRef?: React.RefObject<HTMLInputElement | null>
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>
}): React.JSX.Element {
  return (
    <Input
      ref={inputRef}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      placeholder={searchHostsLabel()}
      aria-label={searchHostsLabel()}
      className="h-7"
    />
  )
}

/** Make search reachable as a menu row; focus enters the input and arrow keys return to neighboring items. */
export function HostListSearchField({
  value,
  onChange,
  inMenu = false
}: {
  value: string
  onChange: (value: string) => void
  inMenu?: boolean
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  if (!inMenu) {
    return (
      <div className="p-1">
        <HostListSearchInput value={value} onChange={onChange} />
      </div>
    )
  }
  return (
    <DropdownMenuItem
      onSelect={(event) => event.preventDefault()}
      onFocus={(event) => {
        if (event.target === event.currentTarget) {
          inputRef.current?.focus()
        }
      }}
    >
      <HostListSearchInput
        value={value}
        onChange={onChange}
        inputRef={inputRef}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) {
            event.stopPropagation()
            return
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            event.stopPropagation()
            focusAdjacentMenuItem(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1)
            return
          }
          // Why: letters, Space and Enter belong to the input, not the menu's typeahead or select.
          if (event.key !== 'Escape' && event.key !== 'Tab') {
            event.stopPropagation()
          }
        }}
      />
    </DropdownMenuItem>
  )
}

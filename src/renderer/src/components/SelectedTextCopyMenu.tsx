import React from 'react'
import { createPortal } from 'react-dom'
import { Copy } from 'lucide-react'
import { translate } from '@/i18n/i18n'

type SelectedTextCopyMenuProps = {
  children: React.ReactNode
  className?: string
}

type MenuState = {
  x: number
  y: number
  text: string
}

const MENU_WIDTH = 144
const MENU_HEIGHT = 36
const MENU_MARGIN = 8

function getSelectionTextInside(container: HTMLElement): string {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) {
    return ''
  }

  const anchorNode = selection.anchorNode
  const focusNode = selection.focusNode
  if (!anchorNode || !focusNode) {
    return ''
  }

  if (!container.contains(anchorNode) || !container.contains(focusNode)) {
    return ''
  }

  return selection.toString().trim()
}

export function SelectedTextCopyMenu({
  children,
  className
}: SelectedTextCopyMenuProps): React.JSX.Element {
  const [menu, setMenu] = React.useState<MenuState | null>(null)

  React.useEffect(() => {
    if (!menu) {
      return
    }

    const close = (): void => setMenu(null)
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        close()
      }
    }

    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  const handleContextMenu = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const selectedText = getSelectionTextInside(event.currentTarget)
    if (!selectedText) {
      return
    }

    // Why: allowing the event through reopens the workspace card menu. Render
    // this through a body portal so transformed hovercards cannot offset it.
    event.preventDefault()
    event.stopPropagation()
    event.nativeEvent.stopImmediatePropagation()
    setMenu({
      text: selectedText,
      x: Math.max(
        MENU_MARGIN,
        Math.min(event.clientX, window.innerWidth - MENU_WIDTH - MENU_MARGIN)
      ),
      y: Math.max(
        MENU_MARGIN,
        Math.min(event.clientY, window.innerHeight - MENU_HEIGHT - MENU_MARGIN)
      )
    })
  }, [])

  const handleCopy = React.useCallback(() => {
    if (!menu) {
      return
    }
    void window.api.ui.writeClipboardText(menu.text)
    setMenu(null)
  }, [menu])

  return (
    <div className={className} onContextMenuCapture={handleContextMenu}>
      {children}
      {menu &&
        createPortal(
          <div
            className="fixed z-[100] min-w-36 rounded-[11px] border border-black/14 bg-popover p-1 text-popover-foreground shadow-[0_16px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.14)] dark:border-white/14 dark:shadow-[0_20px_44px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.04)]"
            style={{ left: menu.x, top: menu.y }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-1 text-left text-[12px] font-[450] leading-5 outline-hidden hover:bg-accent focus:bg-accent"
              onClick={handleCopy}
            >
              <Copy className="size-3.5 text-muted-foreground" />
              {translate('auto.components.SelectedTextCopyMenu.9b40d7b018', 'Copy')}
            </button>
          </div>,
          document.body
        )}
    </div>
  )
}

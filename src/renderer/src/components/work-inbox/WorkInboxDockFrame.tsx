import type { ReactNode } from 'react'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { useWindowWidth } from '@/components/right-sidebar/use-window-width'
import { translate } from '@/i18n/i18n'
import { WORKSPACE_TOP_CHROME_HEIGHT } from '../sidebar/workspace-chrome-metrics'

export function WorkInboxDockFrame({
  children,
  width,
  setWidth
}: {
  children: ReactNode
  width: number
  setWidth: (width: number) => void
}): React.JSX.Element {
  const windowWidth = useWindowWidth() ?? 1280
  const maxWidth = Math.max(240, Math.min(720, windowWidth / 2))
  const minWidth = Math.min(320, maxWidth)
  const renderedWidth = Math.max(minWidth, Math.min(width, maxWidth))
  const { containerRef, onResizeStart } = useSidebarResize<HTMLElement>({
    isOpen: true,
    width: renderedWidth,
    minWidth,
    maxWidth,
    deltaSign: -1,
    setWidth
  })
  return (
    <aside
      ref={containerRef}
      data-work-inbox-dock
      role="region"
      aria-label={translate('auto.components.work-inbox.title', 'Work Inbox')}
      className="relative flex min-h-0 shrink-0 flex-col border-l border-border bg-background text-foreground"
      style={{ paddingTop: WORKSPACE_TOP_CHROME_HEIGHT }}
    >
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={translate('auto.components.work-inbox.resize', 'Resize inbox')}
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        aria-valuenow={renderedWidth}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-border focus-visible:outline focus-visible:outline-ring"
        onMouseDown={onResizeStart}
        onKeyDown={(event) => {
          const next =
            event.key === 'ArrowLeft'
              ? renderedWidth + 20
              : event.key === 'ArrowRight'
                ? renderedWidth - 20
                : event.key === 'Home'
                  ? minWidth
                  : event.key === 'End'
                    ? maxWidth
                    : null
          if (next !== null) {
            event.preventDefault()
            setWidth(Math.max(minWidth, Math.min(next, maxWidth)))
          }
        }}
      />
      {children}
    </aside>
  )
}

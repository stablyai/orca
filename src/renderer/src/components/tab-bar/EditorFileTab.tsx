import { useEffect, useState } from 'react'
import { X, FileCode, GitCompareArrows, Copy } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { OpenFile } from '../../store/slices/editor'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from './SortableTab'

export default function EditorFileTab({
  file,
  isActive,
  editorFileCount,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseAll
}: {
  file: OpenFile
  isActive: boolean
  editorFileCount: number
  onActivate: () => void
  onClose: () => void
  onCloseOthers: () => void
  onCloseAll: () => void
}): React.JSX.Element {
  const fileName = file.relativePath.split('/').pop() ?? file.relativePath
  const isDiff = file.mode === 'diff'
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })

  useEffect(() => {
    const closeMenu = (): void => setMenuOpen(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [])

  return (
    <>
      <div
        onContextMenuCapture={(event) => {
          event.preventDefault()
          window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
          setMenuPoint({ x: event.clientX, y: event.clientY })
          setMenuOpen(true)
        }}
      >
        <div
          className={`group relative flex items-center h-full px-3 text-sm cursor-pointer select-none shrink-0 border-r border-border ${
            isActive
              ? 'bg-background text-foreground border-b-transparent'
              : 'bg-card text-muted-foreground hover:text-foreground hover:bg-accent/50'
          }`}
          onClick={onActivate}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              e.stopPropagation()
              onClose()
            }
          }}
        >
          {isDiff ? (
            <GitCompareArrows className="w-3.5 h-3.5 mr-1.5 shrink-0 text-muted-foreground" />
          ) : (
            <FileCode className="w-3.5 h-3.5 mr-1.5 shrink-0 text-muted-foreground" />
          )}
          {file.isDirty && (
            <span className="mr-1 size-1.5 rounded-full bg-foreground/60 shrink-0" />
          )}
          <span className="truncate max-w-[130px] mr-1.5">
            {isDiff
              ? file.relativePath === 'All Changes'
                ? 'All Changes'
                : `${fileName} (diff${file.diffStaged ? ' staged' : ''})`
              : fileName}
          </span>
          <button
            className={`flex items-center justify-center w-4 h-4 rounded-sm shrink-0 ${
              isActive
                ? 'text-muted-foreground hover:text-foreground hover:bg-muted'
                : 'text-transparent group-hover:text-muted-foreground hover:!text-foreground hover:!bg-muted'
            }`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none fixed size-px opacity-0"
            style={{ left: menuPoint.x, top: menuPoint.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-48" sideOffset={0} align="start">
          <DropdownMenuItem onSelect={onClose}>Close</DropdownMenuItem>
          <DropdownMenuItem onSelect={onCloseOthers} disabled={editorFileCount <= 1}>
            Close Others
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onCloseAll}>Close All Editor Tabs</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              navigator.clipboard.writeText(file.filePath)
            }}
          >
            <Copy className="w-3.5 h-3.5 mr-1.5" />
            Copy Path
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

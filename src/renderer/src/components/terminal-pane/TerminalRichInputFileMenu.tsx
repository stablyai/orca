import { useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

export function TerminalRichInputFileMenu({
  id,
  loading,
  error,
  paths,
  activeIndex,
  onChoose
}: {
  id: string
  loading: boolean
  error: string | null
  paths: string[]
  activeIndex: number
  onChoose: (path: string) => void
}): React.JSX.Element {
  const activeOptionRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    activeOptionRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  return (
    <div
      id={id}
      data-terminal-rich-input-menu=""
      className="scrollbar-sleek absolute bottom-full left-0 right-0 z-20 mb-1 max-h-64 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
      role="listbox"
      aria-label={translate('components.terminal.richInput.files', 'Files')}
    >
      {loading ? (
        <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {translate('components.terminal.richInput.loadingFiles', 'Loading files…')}
        </div>
      ) : error ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">{error}</div>
      ) : paths.length === 0 ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          {translate('components.terminal.richInput.noFiles', 'No matching files')}
        </div>
      ) : (
        paths.map((path, index) => {
          const FileIcon = getFileTypeIcon(path)
          return (
            <Button
              id={`${id}-option-${index}`}
              key={path}
              ref={index === activeIndex ? activeOptionRef : null}
              type="button"
              variant="ghost"
              size="sm"
              role="option"
              aria-selected={index === activeIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onChoose(path)}
              className={cn(
                'h-auto min-w-0 w-full justify-start rounded-sm px-2 py-1.5 text-left text-sm',
                index === activeIndex ? 'bg-accent text-accent-foreground' : 'text-foreground'
              )}
            >
              <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono text-xs">{path}</span>
            </Button>
          )
        })
      )}
    </div>
  )
}

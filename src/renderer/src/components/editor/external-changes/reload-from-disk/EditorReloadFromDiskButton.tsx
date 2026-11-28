import { useEffect, useRef } from 'react'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useEditorReloadInFlight } from './editor-reload-in-flight'

type EditorReloadFromDiskButtonProps = {
  fileId: string
  paused: boolean
  onReload: () => void
  /** The button is about to unmount while focused (e.g. the reload found the file deleted). */
  onLoseFocus: () => void
}

/** Always-on ghost reload icon at the start of the editor header's icon group (option B). */
export function EditorReloadFromDiskButton({
  fileId,
  paused,
  onReload,
  onLoseFocus
}: EditorReloadFromDiskButtonProps): React.JSX.Element {
  const t = useTranslate()
  const { busy, spinner } = useEditorReloadInFlight(fileId)
  // Why a flag: removal doesn't reliably fire blur, and by passive cleanup the node is already gone.
  const focusedRef = useRef(false)
  const onLoseFocusRef = useRef(onLoseFocus)
  useEffect(() => {
    onLoseFocusRef.current = onLoseFocus
  })
  useEffect(
    () => () => {
      // Hand focus to a neighbour instead of letting it fall to <body>.
      if (focusedRef.current) {
        onLoseFocusRef.current()
      }
    },
    []
  )

  const tooltip = paused
    ? t('editor.reloadFromDisk.tooltipPaused', 'Reload from Disk · auto-reload paused')
    : t('auto.components.editor.ExternalFileChangeBanner.3fa2b8d417', 'Reload from Disk')
  const ariaLabel = paused
    ? t('editor.reloadFromDisk.ariaLabelPaused', 'Reload from Disk, auto-reload paused')
    : tooltip

  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              // Why aria-disabled, not disabled: the button keeps focus and looks unchanged until the spinner shows.
              aria-disabled={busy || undefined}
              aria-busy={spinner || undefined}
              aria-label={ariaLabel}
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onFocus={() => {
                focusedRef.current = true
              }}
              onBlur={() => {
                focusedRef.current = false
              }}
              onClick={() => {
                if (!busy) {
                  onReload()
                }
              }}
            >
              {spinner ? (
                <LoaderCircle
                  size={14}
                  className="animate-spin motion-reduce:animate-none motion-reduce:opacity-60"
                />
              ) : (
                <RefreshCw size={14} />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {tooltip}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <span aria-hidden className="mx-1 h-4 w-px flex-shrink-0 bg-border" />
    </>
  )
}

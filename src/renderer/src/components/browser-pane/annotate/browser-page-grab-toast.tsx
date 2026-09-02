import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { CircleCheck, Image, OctagonX } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type { BrowserPageGrabToastState } from '../describe-page/browser-page-types'

export function BrowserPageGrabToast({
  grabToast,
  grabToastTimerRef,
  dismissGrabToast,
  setGrabToast
}: {
  grabToast: BrowserPageGrabToastState
  grabToastTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | undefined>
  dismissGrabToast: () => void
  setGrabToast: Dispatch<SetStateAction<BrowserPageGrabToastState | null>>
}): React.JSX.Element {
  return (
    <div
      className="absolute z-30 flex items-center animate-in fade-in zoom-in-95 duration-150"
      style={{
        left: grabToast.x,
        top: grabToast.y,
        transform: grabToast.below
          ? 'translate(-50%, 8px)'
          : 'translate(-50%, -100%) translateY(-8px)',
        flexDirection: grabToast.below ? 'column' : 'column-reverse'
      }}
    >
      {/* Caret pointing toward the element */}
      <div
        className="h-2 w-4 shrink-0"
        style={{
          clipPath: grabToast.below
            ? 'polygon(50% 0%, 0% 100%, 100% 100%)'
            : 'polygon(0% 0%, 100% 0%, 50% 100%)',
          background: 'white'
        }}
      />
      <div
        className={`flex items-center gap-1.5 rounded-full py-1.5 pl-3 pr-1.5 shadow-lg ${
          grabToast.type === 'success' ? 'bg-white text-gray-900' : 'bg-white text-red-600'
        }`}
      >
        {grabToast.type === 'success' ? (
          <CircleCheck className="size-4 fill-blue-600 text-white" />
        ) : (
          <OctagonX className="size-4 text-red-500" />
        )}
        <span className="text-sm font-semibold">{grabToast.message}</span>
        {grabToast.payload?.screenshot?.dataUrl?.startsWith('data:image/png;base64,') ? (
          <DropdownMenu
            onOpenChange={(open) => {
              if (open) {
                clearTimeout(grabToastTimerRef.current)
              } else {
                grabToastTimerRef.current = setTimeout(() => dismissGrabToast(), 1200)
              }
            }}
          >
            <DropdownMenuTrigger asChild>
              <button className="flex size-6 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-black/10 hover:text-gray-700">
                <span className="text-sm font-bold leading-none">···</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={4}>
              <DropdownMenuItem
                onSelect={() => {
                  const dataUrl = grabToast.payload?.screenshot?.dataUrl
                  if (dataUrl?.startsWith('data:image/png;base64,')) {
                    void window.api.ui.writeClipboardImage(dataUrl)
                    setGrabToast((prev) =>
                      prev
                        ? {
                            ...prev,
                            message: translate(
                              'auto.components.browser.pane.BrowserPane.f30d2d35a7',
                              'Screenshotted'
                            )
                          }
                        : null
                    )
                  }
                }}
              >
                <Image className="size-3.5" />
                {translate(
                  'auto.components.browser.pane.BrowserPane.1ded0d3168',
                  'Copy Screenshot'
                )}
                <DropdownMenuShortcut>S</DropdownMenuShortcut>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  )
}

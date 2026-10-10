import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'

export const TAB_TOOLTIP_DELAY_MS = 500
export const TAB_TOOLTIP_SKIP_DELAY_MS = 300

type TabCardPlacement = {
  element: HTMLElement
  left: number
  top: number
  closedAt: number | null
}

export const TabCardPlacementContext = createContext<RefObject<TabCardPlacement | null> | null>(
  null
)

export const TabCardOpenContext = createContext<{
  isWarm: boolean
  onOpenChange: (id: string, open: boolean) => void
} | null>(null)

export function TabStripTooltipProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const placement = useRef<TabCardPlacement | null>(null)
  const openCardId = useRef<string | null>(null)
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isWarm, setIsWarm] = useState(false)
  const onOpenChange = useCallback((id: string, open: boolean) => {
    // A previous card's close may arrive after the next card opens.
    if (!open && openCardId.current !== id) {
      return
    }
    if (cooldownTimer.current !== null) {
      clearTimeout(cooldownTimer.current)
      cooldownTimer.current = null
    }
    openCardId.current = open ? id : null
    if (open) {
      setIsWarm(true)
    } else {
      cooldownTimer.current = setTimeout(() => {
        cooldownTimer.current = null
        setIsWarm(false)
      }, TAB_TOOLTIP_SKIP_DELAY_MS)
    }
  }, [])
  useEffect(
    () => () => {
      if (cooldownTimer.current !== null) {
        clearTimeout(cooldownTimer.current)
      }
    },
    []
  )
  const openContext = useMemo(() => ({ isWarm, onOpenChange }), [isWarm, onOpenChange])
  return (
    <TabCardPlacementContext.Provider value={placement}>
      <TabCardOpenContext.Provider value={openContext}>
        <TooltipProvider
          delayDuration={TAB_TOOLTIP_DELAY_MS}
          skipDelayDuration={TAB_TOOLTIP_SKIP_DELAY_MS}
        >
          {children}
        </TooltipProvider>
      </TabCardOpenContext.Provider>
    </TabCardPlacementContext.Provider>
  )
}

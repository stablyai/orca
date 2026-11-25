import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type RefObject
} from 'react'

export type RuntimeServersDialog = 'add' | 'install'

type RuntimeServersPageState = {
  dialog: RuntimeServersDialog | null
  setDialog: (dialog: RuntimeServersDialog | null, addTrigger?: HTMLElement | null) => void
  addButtonRef: RefObject<HTMLButtonElement | null>
  restoreAddFocus: (event: Event) => void
}

const RuntimeServersPageContext = createContext<RuntimeServersPageState | null>(null)

/** Share dialog state with add/install actions rendered outside the owning pane in section headers. */
export function RuntimeServersPageProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const [dialog, setOpenDialog] = useState<RuntimeServersDialog | null>(null)
  const addTriggerRef = useRef<HTMLElement | null>(null)
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const setDialog = useCallback(
    (next: RuntimeServersDialog | null, addTrigger?: HTMLElement | null) => {
      if (next === 'add') {
        addTriggerRef.current = addTrigger ?? null
      }
      setOpenDialog(next)
    },
    []
  )
  const restoreAddFocus = useCallback((event: Event) => {
    const trigger = addTriggerRef.current
    addTriggerRef.current = null
    const target = trigger?.isConnected ? trigger : addButtonRef.current
    if (target?.isConnected) {
      event.preventDefault()
      target.focus()
    }
  }, [])
  const value = useMemo(
    () => ({ dialog, setDialog, addButtonRef, restoreAddFocus }),
    [dialog, setDialog, restoreAddFocus]
  )
  return (
    <RuntimeServersPageContext.Provider value={value}>
      {children}
    </RuntimeServersPageContext.Provider>
  )
}

export function useRuntimeServersPage(): RuntimeServersPageState {
  const value = useContext(RuntimeServersPageContext)
  if (!value) {
    throw new Error('useRuntimeServersPage must be used inside RuntimeServersPageProvider')
  }
  return value
}

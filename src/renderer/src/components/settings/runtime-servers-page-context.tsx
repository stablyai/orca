import { createContext, useContext, useMemo, useState } from 'react'

export type RuntimeServersDialog = 'add' | 'install'

type RuntimeServersPageState = {
  dialog: RuntimeServersDialog | null
  setDialog: (dialog: RuntimeServersDialog | null) => void
  /** The list shows its empty state, which carries its own add actions. */
  listEmpty: boolean
  setListEmpty: (empty: boolean) => void
}

const RuntimeServersPageContext = createContext<RuntimeServersPageState | null>(null)

/**
 * Why: the add/install actions sit in the settings section header, outside the pane that owns
 * the dialogs, so both read one shared open state.
 */
export function RuntimeServersPageProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const [dialog, setDialog] = useState<RuntimeServersDialog | null>(null)
  const [listEmpty, setListEmpty] = useState(false)
  const value = useMemo(() => ({ dialog, setDialog, listEmpty, setListEmpty }), [dialog, listEmpty])
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

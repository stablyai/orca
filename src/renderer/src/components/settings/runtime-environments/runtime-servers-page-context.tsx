import { createContext, useContext, useMemo, useState } from 'react'

export type RuntimeServersDialog = 'add' | 'install'

type RuntimeServersPageState = {
  dialog: RuntimeServersDialog | null
  setDialog: (dialog: RuntimeServersDialog | null) => void
}

const RuntimeServersPageContext = createContext<RuntimeServersPageState | null>(null)

/** Share dialog state with add/install actions rendered outside the owning pane in section headers. */
export function RuntimeServersPageProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const [dialog, setDialog] = useState<RuntimeServersDialog | null>(null)
  const value = useMemo(() => ({ dialog, setDialog }), [dialog])
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

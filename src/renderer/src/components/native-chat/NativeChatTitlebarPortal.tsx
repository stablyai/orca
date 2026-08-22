import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

type NativeChatTitlebarPortalContextValue = {
  target: HTMLDivElement | null
  setTarget: (target: HTMLDivElement | null) => void
}

const NativeChatTitlebarPortalContext = createContext<NativeChatTitlebarPortalContextValue | null>(
  null
)

export function NativeChatTitlebarPortalProvider({
  children
}: {
  children: ReactNode
}): React.JSX.Element {
  const [target, setTarget] = useState<HTMLDivElement | null>(null)
  const value = useMemo(() => ({ target, setTarget }), [target])

  return (
    <NativeChatTitlebarPortalContext.Provider value={value}>
      {children}
    </NativeChatTitlebarPortalContext.Provider>
  )
}

export function NativeChatTitlebarPortalHost(): React.JSX.Element {
  const portal = useContext(NativeChatTitlebarPortalContext)

  return (
    <>
      {/* Keep trailing titlebar actions at the right edge while the portal host
          spans the full titlebar for true geometric centering. */}
      <div className="min-w-0 flex-1" />
      <div className="titlebar-session-view-host">
        <div id="titlebar-session-view-switcher" ref={portal?.setTarget} />
      </div>
    </>
  )
}

export function useNativeChatTitlebarPortalTarget(): HTMLDivElement | null {
  return useContext(NativeChatTitlebarPortalContext)?.target ?? null
}

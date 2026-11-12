import { createContext, useMemo } from 'react'

/** What an opened run's own window needs from the chat around it; standalone runs get the defaults. */
export type NativeChatToolRunWindowFacts = {
  /** A hidden pane lays nothing out, so its rows must keep their last measured sizes. */
  isVisible: boolean
  /** Find searches drawn text, so every row stays drawn while it has a query. */
  findActive: boolean
}

export const NativeChatToolRunWindowContext = createContext<NativeChatToolRunWindowFacts>({
  isVisible: true,
  findActive: false
})

export function NativeChatToolRunWindowProvider({
  isVisible,
  findActive,
  children
}: NativeChatToolRunWindowFacts & { children: React.ReactNode }): React.JSX.Element {
  const facts = useMemo(() => ({ isVisible, findActive }), [findActive, isVisible])
  return (
    <NativeChatToolRunWindowContext.Provider value={facts}>
      {children}
    </NativeChatToolRunWindowContext.Provider>
  )
}

import { createContext, useContext, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

type SshHostsHeaderSlotState = {
  slot: HTMLElement | null
  setSlot: (node: HTMLElement | null) => void
}

const SshHostsHeaderSlotContext = createContext<SshHostsHeaderSlotState | null>(null)

/** Portal header actions so SshPane retains ownership of sync, restore and add-form state. */
export function SshHostsHeaderSlotProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const value = useMemo(() => ({ slot, setSlot }), [slot])
  return (
    <SshHostsHeaderSlotContext.Provider value={value}>
      {children}
    </SshHostsHeaderSlotContext.Provider>
  )
}

export function SshHostsHeaderSlot(): React.JSX.Element | null {
  const context = useContext(SshHostsHeaderSlotContext)
  return context ? <div ref={context.setSlot} className="flex items-center gap-1.5" /> : null
}

/** Renders inline when no section header provides a slot (tests, other hosts of the pane). */
export function SshHostsHeaderPortal({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element | null {
  const context = useContext(SshHostsHeaderSlotContext)
  if (!context) {
    return <div className="flex justify-end gap-1.5">{children}</div>
  }
  return context.slot ? createPortal(children, context.slot) : null
}

import type { JSX, ReactNode } from 'react'
import { PanelLeft } from 'lucide-react'

/** The miniature window's tab row, sidebar hidden: traffic lights, then the one open tab. */
export function BotsTipWindowTabs({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="bt-tabs">
      <span className="bt-lights">
        <span className="bt-light bg-[#ff5f57]" />
        <span className="bt-light bg-[#ffbd2e]" />
        <span className="bt-light bg-[#28c840]" />
        <PanelLeft className="size-3.5" />
      </span>
      <div className="bt-tab">{children}</div>
    </div>
  )
}

import type { ReactNode } from 'react'

export function NotificationCardStack({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="pointer-events-none fixed bottom-10 right-4 z-40 flex max-h-[calc(100vh-80px)] w-[360px] max-w-[calc(100vw-32px)] flex-col-reverse gap-2 overflow-y-auto scrollbar-sleek [&>*]:pointer-events-auto [&>*]:shrink-0 max-[480px]:left-4 max-[480px]:right-4 max-[480px]:w-auto">
      {children}
    </div>
  )
}

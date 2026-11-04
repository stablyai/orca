import React from 'react'
import { translate } from '@/i18n/i18n'

export default function HomePage(): React.JSX.Element {
  return (
    <main className="relative flex h-full min-h-0 flex-1 flex-col overflow-y-auto scrollbar-sleek bg-background pt-5 text-foreground md:pt-6">
      <header
        className="flex shrink-0 items-center px-3 pb-3 md:px-5"
        style={
          {
            paddingRight: 'max(0.75rem, var(--window-controls-width, 0px))'
          } as React.CSSProperties
        }
      >
        <h1 className="truncate text-base font-semibold leading-8">
          {translate('auto.components.home.HomePage.title', 'Home')}
        </h1>
      </header>
      <div className="flex-1 px-3 pb-6 md:px-5">
        <div className="grid gap-4 md:grid-cols-2" />
      </div>
    </main>
  )
}

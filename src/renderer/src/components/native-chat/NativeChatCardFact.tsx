import type { ReactNode } from 'react'

/** One label/value row of a card's opened details, inside a two-column `dl`. */
export function NativeChatCardFact({
  label,
  children
}: {
  label: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <>
      <dt className="pt-0.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-sm text-foreground">{children}</dd>
    </>
  )
}

import { useState, type ComponentProps, type ReactNode } from 'react'
import { DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { TabBarAgentPickerEntry } from './TabBarAgentPickerEntry'

export function TabBarCreateMenuContent({
  children,
  entryProps
}: {
  children: ReactNode
  entryProps?: Omit<ComponentProps<typeof TabBarAgentPickerEntry>, 'onQueryChange'>
}): React.JSX.Element {
  // Keep typing out of the tab strip and its workspace/agent projections.
  const [hasQuery, setHasQuery] = useState(false)
  return (
    <>
      {entryProps ? (
        <TabBarAgentPickerEntry
          {...entryProps}
          onQueryChange={(query) => setHasQuery(query.trim().length > 0)}
        />
      ) : null}
      {!hasQuery ? (
        <>
          {entryProps ? <DropdownMenuSeparator /> : null}
          {children}
        </>
      ) : null}
    </>
  )
}

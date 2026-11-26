import type React from 'react'

/**
 * With Tab position: Left, the group's tab list sits beside its body. The body keeps its own
 * element and anchor, so retained terminals and webviews follow its new box without remounting.
 */
export function TabGroupBodyRow({
  tabList,
  children
}: {
  tabList: React.ReactNode | null
  children: React.ReactNode
}): React.JSX.Element {
  if (tabList === null) {
    return <>{children}</>
  }
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden" data-tab-group-body-row="">
      {tabList}
      {children}
    </div>
  )
}

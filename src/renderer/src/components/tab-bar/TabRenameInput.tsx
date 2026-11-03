import type React from 'react'
import { Input } from '@/components/ui/input'

type TabRenameInputProps = Omit<
  React.ComponentProps<typeof Input>,
  'density' | 'className' | 'spellCheck'
>

/** Inline tab rename field; isolates pointer events so editing never activates or drags the tab. */
export function TabRenameInput(props: TabRenameInputProps): React.JSX.Element {
  return (
    <Input
      {...props}
      density="compact"
      data-tab-rename-input="true"
      className="mr-1 min-w-0 flex-1"
      spellCheck={false}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        event.stopPropagation()
        // Middle-click would paste the X11 primary selection on Linux.
        if (event.button === 1) {
          event.preventDefault()
        }
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onAuxClick={(event) => event.stopPropagation()}
    />
  )
}

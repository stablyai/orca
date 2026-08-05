/** @vitest-environment happy-dom */
import { act, useCallback, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import {
  setActivityTerminalPortals,
  useActivityTerminalPortals,
  type ActivityTerminalPortalTarget
} from './activity-terminal-portal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const target = document.createElement('div')
const descriptor: ActivityTerminalPortalTarget = {
  slotId: 'primary',
  requestToken: 'primary:tab-a:leaf-a',
  target,
  worktreeId: 'worktree-a',
  tabId: 'tab-a',
  paneKey: 'tab-a:leaf-a',
  active: true
}

afterEach(() => setActivityTerminalPortals([]))

describe('Activity terminal portal publication loop', () => {
  it('settles when Terminal feeds an identical descriptor back into Activity', () => {
    let renders = 0

    function ActivityPublisher(): null {
      useLayoutEffect(() => setActivityTerminalPortals([{ ...descriptor }]))
      return null
    }

    function TerminalSubscriber({ invalidate }: { invalidate: () => void }): null {
      const portals = useActivityTerminalPortals(true)
      useLayoutEffect(invalidate, [invalidate, portals])
      return null
    }

    function CrossSurfaceHost(): React.JSX.Element {
      renders += 1
      const [, setRevision] = useState(0)
      const invalidate = useCallback(() => setRevision((revision) => revision + 1), [])
      return (
        <>
          <ActivityPublisher />
          <TerminalSubscriber invalidate={invalidate} />
        </>
      )
    }

    const root = createRoot(document.createElement('div'))
    expect(() => act(() => root.render(<CrossSurfaceHost />))).not.toThrow()
    expect(renders).toBeLessThan(10)
    act(() => root.unmount())
  })
})

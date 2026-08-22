/**
 * @vitest-environment happy-dom
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import {
  NativeChatTitlebarPortalHost,
  NativeChatTitlebarPortalProvider,
  useNativeChatTitlebarPortalTarget
} from './NativeChatTitlebarPortal'

function PortalTargetState(): React.JSX.Element {
  const target = useNativeChatTitlebarPortalTarget()
  return <output data-target-ready={target !== null} />
}

it('tracks the titlebar portal target across its initial mount and remount', () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const render = (showHost: boolean): void => {
    act(() => {
      root.render(
        <NativeChatTitlebarPortalProvider>
          {showHost ? <NativeChatTitlebarPortalHost /> : null}
          <PortalTargetState />
        </NativeChatTitlebarPortalProvider>
      )
    })
  }

  render(true)
  expect(container.querySelector('output')?.dataset.targetReady).toBe('true')

  render(false)
  expect(container.querySelector('output')?.dataset.targetReady).toBe('false')

  render(true)
  expect(container.querySelector('output')?.dataset.targetReady).toBe('true')

  act(() => root.unmount())
  container.remove()
})

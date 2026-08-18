// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { CloudVmSetupGuide } from './CloudVmSetupGuide'

describe('CloudVmSetupGuide', () => {
  afterEach(() => {
    useAppStore.setState({ settingsNavigationTarget: null })
    document.body.replaceChildren()
  })

  it('explains creation and opens environment recipe setup', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => root.render(<CloudVmSetupGuide />))

    expect(container.textContent).toContain('Create a Cloud VM')
    expect(container.textContent).toContain('Create a workspace')

    const button = container.querySelector('button')
    if (!button) {
      throw new Error('Cloud VM setup button was not rendered')
    }
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(useAppStore.getState().settingsNavigationTarget).toEqual({
      pane: 'experimental',
      repoId: null,
      sectionId: 'ephemeral-vms'
    })
    act(() => root.unmount())
  })
})

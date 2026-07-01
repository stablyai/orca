// @vitest-environment happy-dom
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '../../store'
import { UpdateStatusSegment } from './UpdateStatusSegment'

describe('UpdateStatusSegment', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    root?.unmount()
    root = null
    container?.remove()
    container = null
    useAppStore.setState({
      updateCardCollapsed: false,
      updateStatus: { state: 'idle' }
    })
  })

  it('renders 100 percent downloading as finalizing', async () => {
    useAppStore.setState({
      updateCardCollapsed: true,
      updateStatus: { state: 'downloading', percent: 100, version: '1.2.0' }
    })

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        createElement(
          TooltipProvider,
          null,
          createElement(UpdateStatusSegment, { compact: false, iconOnly: false })
        )
      )
    })

    expect(container.textContent).toContain('Finalizing')
    expect(container.textContent).not.toContain('100%')
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Update finalizing. Click to expand.'
    )
  })
})

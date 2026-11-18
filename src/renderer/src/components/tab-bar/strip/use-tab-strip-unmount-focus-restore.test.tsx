// @vitest-environment happy-dom

import { act } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../../../store'
import { useTabStripUnmountFocusRestore } from './use-tab-strip-unmount-focus-restore'

let strip: HTMLElement

beforeEach(() => {
  useAppStore.setState({ activeWorktreeId: 'wt', activeGroupIdByWorktree: { wt: 'g1' } })
  // happy-dom has no layout; treat connected elements as shown.
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.isConnected ? document.body : null
    }
  })
  document.body.innerHTML = `
    <div id="strip"><div data-tab-strip-slot="t1"><div tabindex="0" id="t1-root"></div></div></div>
    <textarea id="other-group-terminal"></textarea>`
  strip = document.getElementById('strip')!
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetParent')
  useAppStore.setState(useAppStore.getInitialState(), true)
  document.body.innerHTML = ''
})

function Chip({ open }: { open: boolean }): null {
  useTabStripUnmountFocusRestore({
    open,
    surface: strip,
    activeId: 't1',
    worktreeId: 'wt',
    groupId: 'g1'
  })
  return null
}

function Harness({ chip }: { chip: boolean }): React.JSX.Element | null {
  return chip ? <Chip open /> : null
}

async function nextFrame(): Promise<void> {
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
}

describe('useTabStripUnmountFocusRestore', () => {
  it('focuses the active tab when the chip unmounts with its list open', async () => {
    const { rerender } = render(<Harness chip />)
    rerender(<Harness chip={false} />)
    await nextFrame()
    expect(document.activeElement?.id).toBe('t1-root')
  })

  it('leaves focus alone when a group switch unmounts the chip in the same commit', async () => {
    const { rerender } = render(<Harness chip />)
    const otherTerminal = document.getElementById('other-group-terminal')!
    act(() => {
      otherTerminal.focus()
      useAppStore.setState({ activeGroupIdByWorktree: { wt: 'g2' } })
      rerender(<Harness chip={false} />)
    })
    await nextFrame()
    expect(document.activeElement).toBe(otherTerminal)
  })

  it('leaves focus alone when the workspace switches before the deferred restore runs', async () => {
    const { rerender } = render(<Harness chip />)
    rerender(<Harness chip={false} />)
    useAppStore.setState({ activeWorktreeId: 'wt-other' })
    await nextFrame()
    expect(document.activeElement).toBe(document.body)
  })
})

import { describe, expect, it } from 'vitest'
import { createTerminalPaneHandleRegistry } from './terminal-pane-handle-registry'

type FakeHandle = { closeActivePane: () => void }

function createHandle(): FakeHandle {
  return { closeActivePane: () => {} }
}

describe('createTerminalPaneHandleRegistry', () => {
  it('returns the same ref callback for a tab id across renders', () => {
    const registry = createTerminalPaneHandleRegistry<FakeHandle>()
    expect(registry.getRefCallback('tab-1')).toBe(registry.getRefCallback('tab-1'))
    expect(registry.getRefCallback('tab-2')).not.toBe(registry.getRefCallback('tab-1'))
  })

  it('exposes the attached handle and clears it on detach', () => {
    const registry = createTerminalPaneHandleRegistry<FakeHandle>()
    const handle = createHandle()
    const register = registry.getRefCallback('tab-1')

    register(handle)
    expect(registry.getHandle('tab-1')).toBe(handle)

    register(null)
    expect(registry.getHandle('tab-1')).toBeNull()
  })

  it('keeps callback identity stable through a same-id remount', () => {
    const registry = createTerminalPaneHandleRegistry<FakeHandle>()
    const first = registry.getRefCallback('tab-1')
    first(createHandle())

    // Generation bump: React detaches the old element, then attaches the new one.
    first(null)
    const remounted = registry.getRefCallback('tab-1')
    const handle = createHandle()
    remounted(handle)

    expect(remounted).toBe(first)
    expect(registry.getRefCallback('tab-1')).toBe(first)
    expect(registry.getHandle('tab-1')).toBe(handle)
  })

  it('does not re-attach on parent renders that follow a remount', () => {
    const registry = createTerminalPaneHandleRegistry<FakeHandle>()
    let attachedCallback: ((handle: FakeHandle | null) => void) | null = null
    let handle: FakeHandle | null = null
    let attachCount = 0

    // One render + commit of the pane: React only touches the ref when its identity changed.
    const commit = (): void => {
      const next = registry.getRefCallback('tab-1')
      if (next === attachedCallback) {
        return
      }
      attachedCallback?.(null)
      handle = createHandle()
      next(handle)
      attachedCallback = next
      attachCount += 1
    }

    // Generation bump: the render reads the cache first, then the commit swaps the two elements.
    const remount = (): void => {
      const next = registry.getRefCallback('tab-1')
      attachedCallback?.(null)
      handle = createHandle()
      next(handle)
      attachedCallback = next
      attachCount += 1
    }

    commit()
    remount()
    commit()
    commit()
    commit()

    expect(attachCount).toBe(2)
    expect(registry.getHandle('tab-1')).toBe(handle)
  })

  it('re-arms the cache when a pruned tab attaches again', () => {
    const registry = createTerminalPaneHandleRegistry<FakeHandle>()
    const register = registry.getRefCallback('tab-1')

    registry.retainOnly([])
    // The pruned callback is still live in React's committed tree until it detaches.
    register(createHandle())

    expect(registry.getRefCallback('tab-1')).toBe(register)
  })

  it('prunes entries for tabs that left the panel', () => {
    const registry = createTerminalPaneHandleRegistry<FakeHandle>()
    registry.getRefCallback('tab-1')(createHandle())
    const survivor = registry.getRefCallback('tab-2')
    survivor(createHandle())

    registry.retainOnly(['tab-2'])

    expect(registry.getHandle('tab-1')).toBeNull()
    expect(registry.getRefCallback('tab-1')).not.toBe(survivor)
    expect(registry.getRefCallback('tab-2')).toBe(survivor)
    expect(registry.getHandle('tab-2')).not.toBeNull()
  })
})

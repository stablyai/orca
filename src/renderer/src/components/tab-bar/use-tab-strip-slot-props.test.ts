import { describe, expect, it, vi } from 'vitest'
import {
  TAB_CONTAINER_WIDTH_CLASSES,
  TAB_ICON_ONLY_CONTAINER_WIDTH_CLASSES
} from './tab-width-rules'
import { useTabStripSlotProps } from './use-tab-strip-slot-props'

vi.mock('../tab-group/tab-drag-context', () => ({ useTabDragActive: () => false }))

describe('useTabStripSlotProps', () => {
  it('keeps the fixed tab width by default', () => {
    expect(useTabStripSlotProps('tab-1', false).className).toBe(TAB_CONTAINER_WIDTH_CLASSES)
  })

  it('shrink-wraps an icon-only tab instead of reserving the fixed width', () => {
    const { className } = useTabStripSlotProps('tab-1', false, true)

    expect(className).toBe(TAB_ICON_ONLY_CONTAINER_WIDTH_CLASSES)
    expect(className).not.toContain('w-[180px]')
  })

  // An active icon-only tab still docks, so the collapse must not drop the sticky classes.
  it('still docks an active icon-only tab', () => {
    const props = useTabStripSlotProps('tab-1', true, true)

    expect(props.className).toContain('sticky')
    expect(props['data-active-tab-dock']).toBe('')
  })
})

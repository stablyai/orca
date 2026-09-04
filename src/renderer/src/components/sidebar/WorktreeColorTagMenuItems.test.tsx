import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { WorktreeColorTagMenuItems } from './WorktreeColorTagMenuItems'
import { WORKSPACE_COLOR_TAG_SWATCHES } from '../../../../shared/workspace-color-tag'

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: (props: {
    children?: ReactNode
    disabled?: boolean
    'aria-label'?: string
  }) => (
    <div role="menuitem" aria-label={props['aria-label']} data-disabled={props.disabled}>
      {props.children}
    </div>
  )
}))

function render(props: { colorTag: string | null; mixed?: boolean; disabled?: boolean }): string {
  return renderToStaticMarkup(
    <WorktreeColorTagMenuItems
      colorTag={props.colorTag}
      mixed={props.mixed ?? false}
      disabled={props.disabled ?? false}
      isMultiContext={false}
      onAssignColorTag={vi.fn()}
      onOpenCustomPicker={vi.fn()}
    />
  )
}

/** The rendered swatch button for one option, so assertions can look inside a single element. */
function swatchTag(markup: string, key: string): string {
  const match = markup.match(new RegExp(`<button[^>]*data-workspace-color-swatch="${key}"[^>]*>`))
  if (!match) {
    throw new Error(`no swatch ${key}`)
  }
  return match[0]
}

describe('WorktreeColorTagMenuItems', () => {
  // Regression: a stored custom color is not in the preset row, so indexOf landed the keyboard
  // cursor on the empty slot and Enter cleared the tag the user was looking at.
  it('starts the keyboard cursor on the wheel for a stored custom color', () => {
    const markup = render({ colorTag: '#123456' })
    expect(markup).toContain('aria-label="Group color: Custom color"')
    expect(markup).not.toContain('aria-checked="true"')
    expect(swatchTag(markup, 'custom')).toContain('ring-2')
  })

  it('checks the matching preset and names its removal in the row label', () => {
    const markup = render({ colorTag: '#ef4444' })
    expect(swatchTag(markup, '#ef4444')).toContain('aria-checked="true"')
    expect(markup).toContain('aria-label="Group color: Remove color #ef4444"')
  })

  it('checks the empty slot for an untagged workspace', () => {
    const markup = render({ colorTag: null })
    expect(swatchTag(markup, 'none')).toContain('aria-checked="true"')
    expect(markup).toContain('aria-label="Group color: No color"')
  })

  // Regression: mixed and all-untagged both reported null, so a mixed selection showed the empty
  // slot as checked.
  it('checks nothing for a mixed selection', () => {
    expect(render({ colorTag: null, mixed: true })).not.toContain('aria-checked="true"')
  })

  // Regression: the wheel's gradient hard-coded a copy of the palette that had already drifted
  // (it omitted orange), so palette edits would not reach the custom affordance.
  it('sweeps every preset through the custom wheel', () => {
    const wheel = swatchTag(render({ colorTag: null }), 'custom')
    for (const swatch of WORKSPACE_COLOR_TAG_SWATCHES) {
      expect(wheel).toContain(swatch)
    }
  })

  it('disables the whole row when told the selection is deleting', () => {
    expect(render({ colorTag: null, disabled: true })).toContain('data-disabled="true"')
  })
})

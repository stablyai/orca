// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from './sheet'

afterEach(cleanup)

describe('SheetContent', () => {
  it('can render a non-modal inspector without an overlay', () => {
    render(
      <Sheet open modal={false}>
        <SheetContent showOverlay={false}>
          <SheetTitle>Progress</SheetTitle>
          <SheetDescription>Live transcript</SheetDescription>
        </SheetContent>
      </Sheet>
    )

    expect(document.querySelector('[data-slot="sheet-content"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeNull()
  })
})

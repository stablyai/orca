import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const newLinearIssueDialogSources = [
  './task-page/linear/IssueDialog.tsx',
  './task-page/linear/IssueAttributes.tsx'
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))

/** The extracted Linear "New Issue" dialog and its attribute pickers. */
function newLinearIssueDialog(): string {
  return newLinearIssueDialogSources.join('\n')
}

function popoverContentClassNames(section: string): string[] {
  return [...section.matchAll(/<PopoverContent\b[^>]*?className="([^"]*)"/gs)].map((m) => m[1])
}

describe('Linear new-issue dialog popovers', () => {
  it('caps every attribute popover to the available height and opts into the wheel shim', () => {
    const classNames = popoverContentClassNames(newLinearIssueDialog())

    expect(classNames.length).toBeGreaterThanOrEqual(6)
    for (const className of classNames) {
      expect(className).toContain('popover-scroll-content')
      expect(className).toContain('scrollbar-sleek')
    }
  })

  it('leaves no fixed-height inner scroller that the outer cap would clip', () => {
    // Only wrapper divs: the description textarea caps its own growth with the
    // same classes and is not a popover child.
    const wrapperClassNames = [
      ...newLinearIssueDialog().matchAll(/<div\b[^>]*?className="([^"]*)"/gs)
    ].map((m) => m[1])

    for (const className of wrapperClassNames) {
      const tokens = new Set(className.split(/\s+/))
      const isFixedScroller =
        tokens.has('max-h-60') && tokens.has('overflow-y-auto') && tokens.has('scrollbar-sleek')
      expect(isFixedScroller, `fixed-height inner scroller: ${className}`).toBe(false)
    }
  })
})

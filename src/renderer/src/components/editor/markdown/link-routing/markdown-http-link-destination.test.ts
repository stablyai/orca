// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { resolveMarkdownHttpLinkDestination } from './markdown-external-url-open'

// Markdown surfaces follow the terminal's Link routing: the setting picks the default and Shift
// inverts it for one click when that option is on (#44311).
describe('resolveMarkdownHttpLinkDestination', () => {
  it('follows the Link routing setting by default', () => {
    expect(resolveMarkdownHttpLinkDestination({ openLinksInApp: true }, false)).toBe('orca')
    expect(resolveMarkdownHttpLinkDestination({ openLinksInApp: false }, false)).toBe('system')
  })

  it('keeps Shift forcing the system browser when the invert option is off', () => {
    expect(
      resolveMarkdownHttpLinkDestination(
        { openLinksInApp: true, openLinksInAppModifierInverts: false },
        true
      )
    ).toBe('system')
  })

  it('lets Shift invert the routing when the invert option is on', () => {
    expect(
      resolveMarkdownHttpLinkDestination(
        { openLinksInApp: false, openLinksInAppModifierInverts: true },
        true
      )
    ).toBe('orca')
    expect(
      resolveMarkdownHttpLinkDestination(
        { openLinksInApp: true, openLinksInAppModifierInverts: true },
        true
      )
    ).toBe('system')
  })

  it('treats missing settings as system-routed', () => {
    expect(resolveMarkdownHttpLinkDestination(undefined, false)).toBe('system')
    expect(resolveMarkdownHttpLinkDestination(null, false)).toBe('system')
  })
})

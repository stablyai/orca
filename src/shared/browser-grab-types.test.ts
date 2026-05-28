import { describe, expect, it } from 'vitest'
import {
  GRAB_BUDGET,
  GRAB_SAFE_ATTRIBUTE_NAMES,
  GRAB_SECRET_PATTERNS,
  GRAB_STYLE_PROPERTIES,
  isAriaAttribute
} from './browser-grab-types'

describe('browser-grab-types', () => {
  describe('GRAB_BUDGET', () => {
    it('defines all required budget fields', () => {
      expect(GRAB_BUDGET.textSnippetMaxLength).toBe(200)
      expect(GRAB_BUDGET.nearbyTextEntryMaxLength).toBe(200)
      expect(GRAB_BUDGET.nearbyTextMaxEntries).toBe(10)
      expect(GRAB_BUDGET.htmlSnippetMaxLength).toBe(4096)
      expect(GRAB_BUDGET.ancestorPathMaxEntries).toBe(10)
      expect(GRAB_BUDGET.nearbyElementMaxLength).toBe(160)
      expect(GRAB_BUDGET.cssClassesMaxLength).toBe(500)
      expect(GRAB_BUDGET.selectedTextMaxLength).toBe(500)
      expect(GRAB_BUDGET.annotationsMaxPerPage).toBe(20)
      expect(GRAB_BUDGET.screenshotMaxBytes).toBe(2 * 1024 * 1024)
    })
  })

  describe('isAriaAttribute', () => {
    it('returns true for aria- prefixed attributes', () => {
      expect(isAriaAttribute('aria-label')).toBe(true)
      expect(isAriaAttribute('aria-labelledby')).toBe(true)
      expect(isAriaAttribute('aria-hidden')).toBe(true)
    })

    it('returns false for non-aria attributes', () => {
      expect(isAriaAttribute('class')).toBe(false)
      expect(isAriaAttribute('id')).toBe(false)
      expect(isAriaAttribute('notaria-label')).toBe(false)
    })
  })

  describe('GRAB_SAFE_ATTRIBUTE_NAMES', () => {
    it('includes core safe attributes', () => {
      expect(GRAB_SAFE_ATTRIBUTE_NAMES.has('id')).toBe(true)
      expect(GRAB_SAFE_ATTRIBUTE_NAMES.has('class')).toBe(true)
      expect(GRAB_SAFE_ATTRIBUTE_NAMES.has('role')).toBe(true)
      expect(GRAB_SAFE_ATTRIBUTE_NAMES.has('type')).toBe(true)
    })

    it('does not include unsafe attributes', () => {
      expect(GRAB_SAFE_ATTRIBUTE_NAMES.has('onclick')).toBe(false)
      expect(GRAB_SAFE_ATTRIBUTE_NAMES.has('style')).toBe(false)
      expect(GRAB_SAFE_ATTRIBUTE_NAMES.has('data-secret')).toBe(false)
    })
  })

  describe('GRAB_SECRET_PATTERNS', () => {
    it('includes precise secret patterns', () => {
      expect(GRAB_SECRET_PATTERNS).toContain('access_token')
      expect(GRAB_SECRET_PATTERNS).toContain('api_key')
      expect(GRAB_SECRET_PATTERNS).toContain('password')
      expect(GRAB_SECRET_PATTERNS).toContain('secret')
      expect(GRAB_SECRET_PATTERNS).toContain('session_id')
      expect(GRAB_SECRET_PATTERNS).toContain('csrf')
    })

    it('does not include overly broad patterns', () => {
      // Why: 'code' and 'state' match normal CSS classes like 'source-code'
      // and 'stateful', causing false positive redactions on most sites.
      expect(GRAB_SECRET_PATTERNS).not.toContain('code')
      expect(GRAB_SECRET_PATTERNS).not.toContain('state')
      expect(GRAB_SECRET_PATTERNS).not.toContain('auth')
      expect(GRAB_SECRET_PATTERNS).not.toContain('token')
    })
  })

  describe('GRAB_STYLE_PROPERTIES', () => {
    it('includes the curated subset of computed styles', () => {
      expect(GRAB_STYLE_PROPERTIES).toContain('display')
      expect(GRAB_STYLE_PROPERTIES).toContain('fontSize')
      expect(GRAB_STYLE_PROPERTIES).toContain('backgroundColor')
      expect(GRAB_STYLE_PROPERTIES).toContain('zIndex')
    })

    it('has exactly 16 properties matching the type', () => {
      expect(GRAB_STYLE_PROPERTIES).toHaveLength(16)
    })
  })
})

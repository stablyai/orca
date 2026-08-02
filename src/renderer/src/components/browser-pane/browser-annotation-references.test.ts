import { describe, expect, it } from 'vitest'
import {
  GRAB_BUDGET,
  type BrowserAnnotationReference,
  type BrowserGrabPayload,
  type BrowserGrabPoint
} from '../../../../shared/browser-grab-types'
import {
  appendBrowserAnnotationReference,
  isBrowserAnnotationPointReference,
  browserAnnotationReferenceLabel,
  browserAnnotationReferenceToken,
  clampBrowserAnnotationReferences,
  createBrowserAnnotationReference,
  insertBrowserAnnotationReferenceToken,
  removeBrowserAnnotationReference,
  removeReferenceTokenFromComment,
  stripUnresolvedReferenceTokens
} from './browser-annotation-references'

function makePayload(overrides?: {
  clickPoint?: BrowserGrabPoint | null
  tagName?: string
  selector?: string
  elementPath?: string
  isFixed?: boolean
  accessibleName?: string | null
  textSnippet?: string
}): BrowserGrabPayload {
  return {
    page: {
      sanitizedUrl: 'https://example.com/pricing',
      title: 'Pricing',
      viewportWidth: 1280,
      viewportHeight: 720,
      scrollX: 0,
      scrollY: 120,
      devicePixelRatio: 2,
      capturedAt: '2026-05-15T00:00:00.000Z'
    },
    target: {
      tagName: overrides?.tagName ?? 'button',
      selector: overrides?.selector ?? 'main > button.primary',
      elementPath: overrides?.elementPath,
      isFixed: overrides?.isFixed,
      textSnippet: overrides?.textSnippet ?? '',
      htmlSnippet: '<button class="primary">Sign up</button>',
      attributes: {},
      accessibility: {
        role: 'button',
        accessibleName: overrides?.accessibleName ?? null,
        ariaLabel: null,
        ariaLabelledBy: null
      },
      rectViewport: { x: 10, y: 20, width: 100, height: 40 },
      rectPage: { x: 10, y: 140, width: 100, height: 40 },
      computedStyles: {
        display: 'block',
        position: 'static',
        width: '100px',
        height: '40px',
        margin: '0px',
        padding: '8px',
        color: 'rgb(0, 0, 0)',
        backgroundColor: 'rgb(255, 255, 255)',
        border: 'none',
        borderRadius: '4px',
        fontFamily: 'Inter',
        fontSize: '14px',
        fontWeight: '600',
        lineHeight: '20px',
        textAlign: 'center',
        zIndex: 'auto'
      }
    },
    nearbyText: [],
    ancestorPath: [],
    screenshot: null,
    clickPoint: overrides?.clickPoint ?? null
  }
}

function makeReference(index: number): BrowserAnnotationReference {
  return createBrowserAnnotationReference(makePayload(), index)
}

describe('browserAnnotationReferenceLabel', () => {
  it('prefers the accessible name', () => {
    expect(browserAnnotationReferenceLabel(makePayload({ accessibleName: 'Sign up' }))).toBe(
      'button "Sign up"'
    )
  })

  it('falls back to the text snippet, then the tag name', () => {
    expect(browserAnnotationReferenceLabel(makePayload({ textSnippet: 'Buy now' }))).toBe(
      'button "Buy now"'
    )
    expect(browserAnnotationReferenceLabel(makePayload({ tagName: 'footer' }))).toBe('footer')
  })

  it('collapses whitespace and truncates page-controlled text', () => {
    const label = browserAnnotationReferenceLabel(
      makePayload({ accessibleName: `  Sign\n\tup  ${'x'.repeat(500)}` })
    )
    expect(label.startsWith('button "Sign up x')).toBe(true)
    expect(label.length).toBeLessThanOrEqual(GRAB_BUDGET.annotationReferenceLabelMaxLength)
  })
})

describe('createBrowserAnnotationReference', () => {
  it('keeps identity and geometry but no html snippet', () => {
    const reference = createBrowserAnnotationReference(
      makePayload({ elementPath: 'main > button', isFixed: true }),
      2
    )
    expect(reference).toEqual({
      index: 2,
      label: 'button',
      tagName: 'button',
      selector: 'main > button.primary',
      elementPath: 'main > button',
      isFixed: true,
      rectViewport: { x: 10, y: 20, width: 100, height: 40 },
      rectPage: { x: 10, y: 140, width: 100, height: 40 }
    })
    expect(Object.keys(reference)).not.toContain('htmlSnippet')
  })

  it('omits optional keys when the target has no path and is not fixed', () => {
    const reference = createBrowserAnnotationReference(makePayload(), 1)
    expect('elementPath' in reference).toBe(false)
    expect('isFixed' in reference).toBe(false)
  })
})

describe('element vs point picks', () => {
  const spot: BrowserGrabPoint = {
    viewportX: 640,
    viewportY: 320,
    pageX: 640,
    pageY: 1820,
    offsetX: 520,
    offsetY: 256,
    ratioX: 0.5778,
    ratioY: 0.8,
    hostWidth: 900,
    hostHeight: 320,
    inEmptySpace: true
  }
  const onChild: BrowserGrabPoint = { ...spot, inEmptySpace: false }

  // The case that was broken: a gap inside a container, not just bare background.
  it('treats a click in a container gap as a point, whatever the container is', () => {
    for (const tagName of ['div', 'section', 'body']) {
      const payload = makePayload({ tagName, clickPoint: spot })
      expect(isBrowserAnnotationPointReference(createBrowserAnnotationReference(payload, 1))).toBe(
        true
      )
    }
  })

  it('labels a point by its container and relative position', () => {
    const payload = makePayload({ tagName: 'div', clickPoint: spot })
    expect(browserAnnotationReferenceLabel(payload)).toBe('spot in div (58% across, 80% down)')
  })

  // Why: clicking a child means that child, even though a click point exists.
  it('stays an element when the click landed over a child', () => {
    const payload = makePayload({ accessibleName: 'Sign up', clickPoint: onChild })
    expect(isBrowserAnnotationPointReference(createBrowserAnnotationReference(payload, 1))).toBe(
      false
    )
    expect(browserAnnotationReferenceLabel(payload)).toBe('button "Sign up"')
  })

  // Why: hover extraction reports no click, so there is nothing to anchor to.
  it('falls back to element when no click point was reported', () => {
    const reference = createBrowserAnnotationReference(makePayload({ tagName: 'body' }), 1)
    expect(isBrowserAnnotationPointReference(reference)).toBe(false)
  })

  it('carries the full point, including host box and ratios, onto the reference', () => {
    const reference = createBrowserAnnotationReference(
      makePayload({ tagName: 'div', clickPoint: spot }),
      1
    )
    expect(isBrowserAnnotationPointReference(reference)).toBe(true)
    expect(reference.point).toEqual(spot)
    expect(reference.point?.hostWidth).toBe(900)
    expect(reference.point?.inEmptySpace).toBe(true)
  })

  it('omits the point key entirely when the guest reported no click', () => {
    expect('point' in createBrowserAnnotationReference(makePayload(), 1)).toBe(false)
  })
})

describe('appendBrowserAnnotationReference', () => {
  it('numbers references from 1 and does not mutate the input', () => {
    const first = appendBrowserAnnotationReference([], makePayload())
    const second = appendBrowserAnnotationReference(first, makePayload())
    expect(first).toHaveLength(1)
    expect(second.map((reference) => reference.index)).toEqual([1, 2])
  })

  it('stops at the budget instead of growing the prompt unbounded', () => {
    let references: BrowserAnnotationReference[] = []
    for (let i = 0; i < GRAB_BUDGET.annotationReferencesMax + 3; i += 1) {
      references = appendBrowserAnnotationReference(references, makePayload())
    }
    expect(references).toHaveLength(GRAB_BUDGET.annotationReferencesMax)
  })
})

describe('removeBrowserAnnotationReference', () => {
  it('renumbers the survivors so tokens stay 1..n', () => {
    const references = [makeReference(1), makeReference(2), makeReference(3)]
    const next = removeBrowserAnnotationReference(references, 2)
    expect(next.map((reference) => reference.index)).toEqual([1, 2])
  })

  it('is a no-op for an unknown index', () => {
    const references = [makeReference(1)]
    expect(removeBrowserAnnotationReference(references, 9)).toHaveLength(1)
  })
})

describe('clampBrowserAnnotationReferences', () => {
  it('returns undefined for empty input so persisted annotations stay lean', () => {
    expect(clampBrowserAnnotationReferences(undefined)).toBeUndefined()
    expect(clampBrowserAnnotationReferences([])).toBeUndefined()
  })

  it('caps the count and renumbers', () => {
    const references = Array.from({ length: GRAB_BUDGET.annotationReferencesMax + 2 }, (_, i) =>
      makeReference(i + 10)
    )
    const clamped = clampBrowserAnnotationReferences(references)
    expect(clamped).toHaveLength(GRAB_BUDGET.annotationReferencesMax)
    expect(clamped?.map((reference) => reference.index)).toEqual(
      Array.from({ length: GRAB_BUDGET.annotationReferencesMax }, (_, i) => i + 1)
    )
  })

  it('truncates an oversized label that arrived from persisted state', () => {
    const clamped = clampBrowserAnnotationReferences([
      { ...makeReference(1), label: 'x'.repeat(400) }
    ])
    expect(clamped?.[0].label.length).toBe(GRAB_BUDGET.annotationReferenceLabelMaxLength)
  })
})

describe('insertBrowserAnnotationReferenceToken', () => {
  const token = browserAnnotationReferenceToken(1)

  it('inserts at the caret and reports the caret after the token', () => {
    const result = insertBrowserAnnotationReferenceToken('move this', 9, 9, token)
    expect(result.comment).toBe('move this @ref1')
    expect(result.caret).toBe(result.comment.length)
  })

  it('pads only where padding is missing', () => {
    expect(insertBrowserAnnotationReferenceToken('move this ', 10, 10, token).comment).toBe(
      'move this @ref1'
    )
    expect(insertBrowserAnnotationReferenceToken('', 0, 0, token).comment).toBe('@ref1')
  })

  it('replaces the selection and spaces the token from both sides', () => {
    const result = insertBrowserAnnotationReferenceToken('move HERE now', 5, 9, token)
    expect(result.comment).toBe('move @ref1 now')
    expect(result.comment.slice(result.caret)).toBe(' now')
  })

  it('appends when the caret is unknown or out of range', () => {
    expect(insertBrowserAnnotationReferenceToken('move this', -1, -1, token).comment).toBe(
      'move this @ref1'
    )
    expect(insertBrowserAnnotationReferenceToken('move this', 999, 999, token).comment).toBe(
      'move this @ref1'
    )
  })
})

describe('removeReferenceTokenFromComment', () => {
  it('removes the token for the reference that was deleted', () => {
    expect(removeReferenceTokenFromComment('move this below @ref1 please', 1)).toBe(
      'move this below please'
    )
  })

  // Why: the list renumbers to 1..n on remove, so an un-shifted @ref3 in the
  // text would silently start pointing at a different element.
  it('shifts higher tokens down to match the renumbered list', () => {
    // The user's own words ("and with") stay exactly as typed — only tokens move.
    expect(removeReferenceTokenFromComment('align @ref1 and @ref2 with @ref3 exactly', 2)).toBe(
      'align @ref1 and with @ref2 exactly'
    )
  })

  // Why no trim: the user may still be typing, so trailing space is left alone.
  it('leaves lower tokens untouched', () => {
    expect(removeReferenceTokenFromComment('@ref1 then @ref2', 2)).toBe('@ref1 then ')
  })

  it('does not leave a gap before punctuation', () => {
    expect(removeReferenceTokenFromComment('move it below @ref1.', 1)).toBe('move it below.')
  })

  it('keeps newlines and unrelated @mentions intact', () => {
    expect(removeReferenceTokenFromComment('ask @design\nmove below @ref1', 1)).toBe(
      'ask @design\nmove below '
    )
  })
})

describe('stripUnresolvedReferenceTokens', () => {
  it('keeps tokens that resolve', () => {
    const comment = 'move this below @ref1 and align with @ref2'
    expect(stripUnresolvedReferenceTokens(comment, [makeReference(1), makeReference(2)])).toBe(
      comment
    )
  })

  it('drops tokens left behind after a reference was removed', () => {
    expect(stripUnresolvedReferenceTokens('move this below @ref2', [makeReference(1)])).toBe(
      'move this below'
    )
  })

  it('leaves ordinary @ mentions and email-like text alone', () => {
    const comment = 'ask @design about refs and refresh@example.com'
    expect(stripUnresolvedReferenceTokens(comment, [])).toBe(comment)
  })

  it('preserves newlines while collapsing the gap a dropped token left', () => {
    expect(stripUnresolvedReferenceTokens('move this @ref3 here\nsecond line', [])).toBe(
      'move this here\nsecond line'
    )
  })
})

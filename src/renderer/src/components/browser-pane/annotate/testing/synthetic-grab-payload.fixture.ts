import type { BrowserGrabPayload } from '../../../../../../shared/browser/element-grab/browser-grab-types'

/** A complete picked-element payload for hook tests; values are synthetic. */
export function syntheticGrabPayload(): BrowserGrabPayload {
  return {
    page: {
      sanitizedUrl: 'https://synthetic.test/',
      title: 'Synthetic',
      viewportWidth: 1280,
      viewportHeight: 720,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1,
      capturedAt: '2026-05-15T00:00:00.000Z'
    },
    target: {
      tagName: 'button',
      selector: 'button',
      textSnippet: 'Submit',
      htmlSnippet: '<button>Submit</button>',
      attributes: {},
      accessibility: {
        role: 'button',
        accessibleName: 'Submit',
        ariaLabel: null,
        ariaLabelledBy: null
      },
      rectViewport: { x: 0, y: 0, width: 100, height: 40 },
      rectPage: { x: 0, y: 0, width: 100, height: 40 },
      computedStyles: {
        display: 'inline-flex',
        position: 'static',
        width: '100px',
        height: '40px',
        margin: '0px',
        padding: '0px',
        color: 'rgb(0, 0, 0)',
        backgroundColor: 'rgba(0, 0, 0, 0)',
        border: '0px none',
        borderRadius: '0px',
        fontFamily: 'Geist',
        fontSize: '14px',
        fontWeight: '400',
        lineHeight: '20px',
        textAlign: 'center',
        zIndex: 'auto'
      }
    },
    nearbyText: [],
    ancestorPath: [],
    screenshot: null
  }
}

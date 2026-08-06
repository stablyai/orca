// Markup → recording log element resolution.
//
// Markup shapes are vector objects in CSS-viewport coordinates. When the
// recorder is active we resolve each shape's "target point" (arrow tip, rect
// center, text anchor, pen end) back to the DOM element underneath via
// elementFromPoint, so the copied log can say *what* the scribble points at,
// not just where. Resolution is best-effort: a failed query or a point over
// the page background leaves element undefined and the geometry alone.
import type { BrowserRecorderMarkupShapeLog } from '../browser-recorder-types'
import type { MarkupShape } from './markup-drawing-model'

/** The point a shape "means": where an arrow aims, a box covers, a label sits. */
export function markupShapeTargetPoint(shape: MarkupShape): { x: number; y: number } {
  switch (shape.kind) {
    case 'pen':
    case 'highlight':
      return shape.points.at(-1) ?? { x: 0, y: 0 }
    case 'arrow':
      return shape.to
    case 'rect':
    case 'ellipse':
      return { x: (shape.from.x + shape.to.x) / 2, y: (shape.from.y + shape.to.y) / 2 }
    case 'text':
      return shape.at
  }
}

/** Geometry/content of one shape, without the (unknown yet) element. */
export function markupShapeToLog(shape: MarkupShape): BrowserRecorderMarkupShapeLog {
  switch (shape.kind) {
    case 'pen':
    case 'highlight':
      return { kind: shape.kind, pointCount: shape.points.length }
    case 'arrow':
      return { kind: 'arrow', from: shape.from, to: shape.to }
    case 'rect':
    case 'ellipse':
      return { kind: shape.kind, from: shape.from, to: shape.to }
    case 'text':
      return { kind: 'text', at: shape.at, text: shape.text }
  }
}

/** In-guest probe: elementFromPoint per target point, returning a compact summary. */
export function buildMarkupElementResolutionScript(
  points: readonly { x: number; y: number }[]
): string {
  return `((points) => {
    const results = [];
    for (const p of points) {
      const el = document.elementFromPoint(p.x, p.y);
      if (!el || el === document.documentElement || el === document.body) {
        results.push(null);
        continue;
      }
      let selector = el.tagName.toLowerCase();
      if (el.id) {
        selector += '#' + el.id;
      } else {
        const cls = typeof el.className === 'string'
          ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2)
          : [];
        if (cls.length > 0) selector += '.' + cls.join('.');
      }
      const name =
        el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '';
      const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
      results.push({
        tagName: el.tagName.toLowerCase(),
        selector,
        accessibleName: name || null,
        textSnippet: text
      });
    }
    return results;
  })(${JSON.stringify(points)})`
}

/**
 * Resolves every shape's target element in the guest page. Shapes are logged
 * with geometry even when the page changed or the query failed.
 */
export async function resolveMarkupShapeElements(
  webview: Electron.WebviewTag,
  shapes: readonly MarkupShape[]
): Promise<BrowserRecorderMarkupShapeLog[]> {
  const logs = shapes.map(markupShapeToLog)
  try {
    const raw = await webview.executeJavaScript(
      buildMarkupElementResolutionScript(shapes.map(markupShapeTargetPoint))
    )
    const results: unknown[] = Array.isArray(raw) ? raw : []
    logs.forEach((log, index) => {
      const element = results[index]
      log.element =
        element && typeof element === 'object'
          ? (element as BrowserRecorderMarkupShapeLog['element'])
          : null
    })
  } catch {
    // Element resolution is best-effort — geometry-only log is still useful.
  }
  return logs
}

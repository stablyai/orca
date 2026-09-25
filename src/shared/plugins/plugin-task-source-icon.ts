/**
 * A task source's `icon` is either a bare Lucide token or a plugin-relative
 * `.svg` the plugin ships. Lives in `shared` so the desktop app, `orca serve`,
 * the CLI and the relay classify and validate it identically.
 *
 * The renderer paints the asset as a CSS mask with `background-color:
 * currentColor`: a mask loads the SVG as an image resource, so it is
 * non-scripted and cannot fetch anything. The checks below are defence in
 * depth, and they give the plugin author a named failure instead of a blank
 * square.
 */

/**
 * 64 KiB. A flat monochrome glyph is a few KB, so this leaves generous room for
 * a detailed path set while the base64 URL it produces stays small enough to
 * ride inside every plugin listing, including over the remote wire.
 */
export const PLUGIN_TASK_SOURCE_ICON_MAX_BYTES = 64 * 1024

export type PluginTaskSourceIconRef =
  | { kind: 'lucide'; name: string }
  | { kind: 'asset'; path: string }

export function isPluginTaskSourceIconAssetPath(value: string): boolean {
  return value.toLowerCase().endsWith('.svg')
}

export function classifyPluginTaskSourceIcon(value: string): PluginTaskSourceIconRef {
  return isPluginTaskSourceIconAssetPath(value)
    ? { kind: 'asset', path: value }
    : { kind: 'lucide', name: value }
}

export type PluginTaskSourceIconResult =
  | { ok: true; dataUrl: string }
  | { ok: false; error: string }

/** Neither can be reached through an image-mask load, but a rejection tells the
 *  author their editor's export is carrying more than a shape. */
const FORBIDDEN_ELEMENTS = new Set(['script', 'foreignobject'])

const NAME_RE = /^[A-Za-z_][\w.:-]*$/

type TagAttribute = { name: string; value: string }

function localName(name: string): string {
  const colon = name.lastIndexOf(':')
  return (colon === -1 ? name : name.slice(colon + 1)).toLowerCase()
}

function attributeError(attribute: TagAttribute): string | null {
  const lowered = attribute.name.toLowerCase()
  const local = localName(attribute.name)
  // The local name is checked too, so a namespace prefix cannot hide a handler.
  if (lowered.startsWith('on') || local.startsWith('on')) {
    return `event handler attribute "${attribute.name}" is not allowed`
  }
  if (local === 'href' && !attribute.value.startsWith('#')) {
    return `"${attribute.name}" must reference a local #fragment`
  }
  return null
}

type TagToken = { attributes: TagAttribute[]; selfClosing: boolean; end: number }

function readAttributes(svg: string, from: number): TagToken | string {
  let index = from
  const attributes: TagAttribute[] = []
  const seen = new Set<string>()
  for (;;) {
    while (index < svg.length && /\s/.test(svg[index] ?? '')) {
      index += 1
    }
    if (index >= svg.length) {
      return 'unterminated tag'
    }
    if (svg.startsWith('/>', index)) {
      return { attributes, selfClosing: true, end: index + 2 }
    }
    if (svg[index] === '>') {
      return { attributes, selfClosing: false, end: index + 1 }
    }
    const nameEnd = (() => {
      let cursor = index
      while (cursor < svg.length && !/[\s=/>]/.test(svg[cursor] ?? '')) {
        cursor += 1
      }
      return cursor
    })()
    const name = svg.slice(index, nameEnd)
    if (!NAME_RE.test(name)) {
      return `malformed attribute name "${name}"`
    }
    if (seen.has(name)) {
      return `duplicate attribute "${name}"`
    }
    seen.add(name)
    index = nameEnd
    while (index < svg.length && /\s/.test(svg[index] ?? '')) {
      index += 1
    }
    if (svg[index] !== '=') {
      return `attribute "${name}" has no value`
    }
    index += 1
    while (index < svg.length && /\s/.test(svg[index] ?? '')) {
      index += 1
    }
    const quote = svg[index]
    if (quote !== '"' && quote !== "'") {
      return `attribute "${name}" value is not quoted`
    }
    const valueEnd = svg.indexOf(quote, index + 1)
    if (valueEnd === -1) {
      return `attribute "${name}" value is unterminated`
    }
    attributes.push({ name, value: svg.slice(index + 1, valueEnd) })
    index = valueEnd + 1
  }
}

function readTagName(svg: string, from: number): { name: string; end: number } | null {
  let cursor = from
  while (cursor < svg.length && !/[\s/>]/.test(svg[cursor] ?? '')) {
    cursor += 1
  }
  const name = svg.slice(from, cursor)
  return NAME_RE.test(name) ? { name, end: cursor } : null
}

function skipDelimited(svg: string, from: number, open: string, close: string): number | string {
  const end = svg.indexOf(close, from + open.length)
  return end === -1 ? `unterminated "${open}"` : end + close.length
}

type ScanState = { open: string[]; rootClosed: boolean; rootSeen: boolean }

function startTagError(svg: string, index: number, state: ScanState): string | number {
  const tagName = readTagName(svg, index + 1)
  if (!tagName) {
    return 'malformed element name'
  }
  const tag = readAttributes(svg, tagName.end)
  if (typeof tag === 'string') {
    return tag
  }
  const local = localName(tagName.name)
  if (state.open.length === 0) {
    if (state.rootSeen) {
      return 'more than one root element'
    }
    if (local !== 'svg') {
      return `root element must be <svg>, not <${tagName.name}>`
    }
    state.rootSeen = true
  }
  if (FORBIDDEN_ELEMENTS.has(local)) {
    return `<${tagName.name}> is not allowed`
  }
  for (const attribute of tag.attributes) {
    const error = attributeError(attribute)
    if (error) {
      return error
    }
  }
  if (tag.selfClosing) {
    state.rootClosed ||= state.open.length === 0
  } else {
    state.open.push(tagName.name)
  }
  return tag.end
}

function endTagError(svg: string, index: number, state: ScanState): string | number {
  const tagName = readTagName(svg, index + 2)
  if (!tagName) {
    return 'malformed element name'
  }
  let cursor = tagName.end
  while (cursor < svg.length && /\s/.test(svg[cursor] ?? '')) {
    cursor += 1
  }
  if (svg[cursor] !== '>') {
    return 'unterminated end tag'
  }
  if (state.open.pop() !== tagName.name) {
    return `</${tagName.name}> does not close the open element`
  }
  state.rootClosed ||= state.open.length === 0
  return cursor + 1
}

/** Returns a reason the SVG is unacceptable, or `null` when it is clean. */
export function pluginTaskSourceIconSvgError(svg: string): string | null {
  const state: ScanState = { open: [], rootClosed: false, rootSeen: false }
  let index = 0
  while (index < svg.length) {
    const lt = svg.indexOf('<', index)
    const text = svg.slice(index, lt === -1 ? svg.length : lt)
    if (state.open.length === 0 && text.trim().length > 0) {
      return 'text outside the root element'
    }
    if (lt === -1) {
      break
    }
    index = lt
    let next: number | string
    if (svg.startsWith('<!--', index)) {
      next = skipDelimited(svg, index, '<!--', '-->')
    } else if (svg.startsWith('<![CDATA[', index)) {
      next = skipDelimited(svg, index, '<![CDATA[', ']]>')
    } else if (svg.startsWith('<!', index)) {
      // A DTD can define entities that expand without limit; no glyph needs one.
      next = 'doctype and other markup declarations are not allowed'
    } else if (svg.startsWith('<?', index)) {
      next = skipDelimited(svg, index, '<?', '?>')
    } else if (svg.startsWith('</', index)) {
      next = endTagError(svg, index, state)
    } else {
      next = startTagError(svg, index, state)
    }
    if (typeof next === 'string') {
      return next
    }
    index = next
  }
  if (state.open.length > 0) {
    return `<${state.open.at(-1)}> is never closed`
  }
  return state.rootClosed ? null : 'no <svg> root element'
}

/** Validates the bytes and encodes them for a CSS mask. Never throws. */
export function buildPluginTaskSourceIconDataUrl(svg: string): PluginTaskSourceIconResult {
  const bytes = Buffer.from(svg, 'utf8')
  if (bytes.byteLength > PLUGIN_TASK_SOURCE_ICON_MAX_BYTES) {
    return {
      ok: false,
      error: `exceeds the ${PLUGIN_TASK_SOURCE_ICON_MAX_BYTES}-byte icon limit`
    }
  }
  const error = pluginTaskSourceIconSvgError(svg)
  return error
    ? { ok: false, error }
    : { ok: true, dataUrl: `data:image/svg+xml;base64,${bytes.toString('base64')}` }
}

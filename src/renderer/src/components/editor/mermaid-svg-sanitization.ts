import DOMPurify from 'dompurify'

function containsExternalCssReference(cssText: string): boolean {
  if (/@import\b|expression\s*\(|(?:https?|data|javascript|file|blob):/i.test(cssText)) {
    return true
  }

  return Array.from(cssText.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)).some(
    ([, , target]) => !target.trim().startsWith('#')
  )
}

function sanitizeStyleElement(style: Element): void {
  if (containsExternalCssReference(style.textContent ?? '')) {
    style.remove()
  }
}

function isUriWhitespace(character: string): boolean {
  const code = character.charCodeAt(0)
  return (
    code <= 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    code === 0x180e ||
    (code >= 0x2000 && code <= 0x2029) ||
    code === 0x205f ||
    code === 0x3000
  )
}

function removeActiveAttributes(element: Element): void {
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase()
    const normalizedValue = Array.from(attribute.value)
      .filter((character) => !isUriWhitespace(character))
      .join('')
      .toLowerCase()
    if (
      name === 'target' ||
      name.startsWith('on') ||
      ((name === 'href' || name === 'xlink:href') &&
        /^(?:data|javascript|vbscript):/.test(normalizedValue))
    ) {
      element.removeAttribute(attribute.name)
    }
  }
}

export function sanitizeMermaidSvg(svg: string): DocumentFragment {
  const fragment = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['style'],
    FORBID_TAGS: ['foreignobject'],
    FORBID_ATTR: ['target'],
    RETURN_DOM_FRAGMENT: true
  })

  fragment.querySelectorAll('foreignObject').forEach((element) => element.remove())
  fragment.querySelectorAll('*').forEach(removeActiveAttributes)
  fragment.querySelectorAll('style').forEach(sanitizeStyleElement)
  return fragment
}

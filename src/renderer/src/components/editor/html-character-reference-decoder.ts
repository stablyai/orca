export type HtmlAttributeQuote = '"' | "'" | null

export function decodeHtmlTextCharacterReferences(value: string): string {
  // Why: a <template> parses markup inertly (no script/resource execution), so
  // reading textContent safely decodes character references without XSS risk.
  const template = document.createElement('template')
  template.innerHTML = value
  return template.content.textContent ?? ''
}

export function decodeHtmlAttributeCharacterReferences(
  value: string,
  quote: HtmlAttributeQuote
): string {
  // Why: inert <template> decoding; attribute write uses the caller-supplied
  // quote and parser-constrained value, so this is not an injection sink.
  const template = document.createElement('template')
  const delimiter = quote ?? ''
  template.innerHTML = `<span data-orca-value=${delimiter}${value}${delimiter}></span>`
  const element = template.content.firstElementChild
  return element?.getAttribute('data-orca-value') ?? ''
}

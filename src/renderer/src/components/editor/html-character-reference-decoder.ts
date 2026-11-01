export type HtmlAttributeQuote = '"' | "'" | null

export function decodeHtmlTextCharacterReferences(value: string): string {
  // An inert template decodes entities without executing scripts or loading resources.
  const template = document.createElement('template')
  template.innerHTML = value
  return template.content.textContent ?? ''
}

export function decodeHtmlAttributeCharacterReferences(
  value: string,
  quote: HtmlAttributeQuote
): string {
  // The inert template uses a parser-constrained value and the caller’s quote, preventing attribute injection.
  const template = document.createElement('template')
  const delimiter = quote ?? ''
  template.innerHTML = `<span data-orca-value=${delimiter}${value}${delimiter}></span>`
  const element = template.content.firstElementChild
  return element?.getAttribute('data-orca-value') ?? ''
}

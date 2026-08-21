// ponytail: mammoth's default styleMap already covers the canonical headings, Strong,
// and list paragraphs. These additions close the gaps users hit most: built-in
// Title/Subtitle/Quote, the Word "No Spacing" / "List Paragraph" styles, the
// common explicit-formatting markers for underline and strikethrough, and the
// alignment-only paragraphs routed via alignTransform.
export const officeDocumentStyleMap: string[] = [
  "p[style-name='Title'] => h1.title:fresh",
  "p[style-name='Subtitle'] => p.subtitle:fresh",
  "p[style-name='Quote'] => blockquote:fresh",
  "p[style-name='Intense Quote'] => blockquote.intenseQuote:fresh",
  "p[style-name='List Paragraph'] => p.listParagraph:fresh",
  "p[style-name='No Spacing'] => p.noSpacing:fresh",
  "r[style-name='Emphasis'] => em",
  'u => u',
  'strike => s',
  'p.AlgnCenter => div.alignmentCenter > p',
  'p.AlgnRight => div.alignmentRight > p',
  'p.AlgnJustify => div.alignmentJustify > p'
]

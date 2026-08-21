// ponytail: closes gaps the default styleMap misses: Title/Subtitle/Quote, List Paragraph/No Spacing, underline/strike, and alignment-only paragraphs routed via alignTransform.
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

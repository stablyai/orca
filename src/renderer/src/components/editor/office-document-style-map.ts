// ponytail: mammoth's default styleMap already covers the canonical headings, Strong,
// and list paragraphs. These additions close the gaps users hit most: built-in
// Title/Subtitle/Quote, the Word "No Spacing" / "List Paragraph" styles, empty
// paragraphs (so mammoth emits `<p></p>` instead of swallowing them), and the
// common explicit-formatting markers for underline and strikethrough.
export const officeDocumentStyleMap: string[] = [
  "p[style-name='Title'] => h1.title:fresh",
  "p[style-name='Subtitle'] => p.subtitle:fresh",
  "p[style-name='Quote'] => blockquote:fresh",
  "p[style-name='Intense Quote'] => blockquote.intenseQuote:fresh",
  "p[style-name='List Paragraph'] => p.listParagraph:fresh",
  "p[style-name='No Spacing'] => p.noSpacing:fresh",
  'p:empty => p.empty:fresh',
  "r[style-name='Emphasis'] => em",
  'u => u',
  'strike => s',
  'p.AlgnCenter => div.alignmentCenter > p',
  'p.AlgnRight => div.alignmentRight > p',
  'p.AlgnJustify => div.alignmentJustify > p'
]

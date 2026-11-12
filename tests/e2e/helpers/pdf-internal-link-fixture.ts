export const PDF_INTERNAL_LINK_PAGE_COUNT = 6
export const PDF_INTERNAL_LINK_TARGET_PAGE = 5
export const PDF_INTERNAL_LINK_SECOND_TARGET_PAGE = 3

/** Link annotations in page order, so a spec can pick them with `.annotationLayer a` + nth. */
export const PDF_INTERNAL_LINKS = {
  /** Page 1: a LaTeX-style \ref to the top of page 5. */
  toTargetPage: 0,
  /** Page 1: a named destination the document does not define, which pdf.js ignores. */
  unresolved: 1,
  /** Page 1: the PDF's own LastPage action. */
  lastPage: 2
} as const

/** A small PDF with in-document links: page 1 → page 5 → page 3, plus a dead link and LastPage. */
export function createPdfInternalLinkFixture(): Buffer {
  const pageId = (page: number): number => 5 + (page - 1) * 2
  const firstLinkId = 5 + PDF_INTERNAL_LINK_PAGE_COUNT * 2
  const xyzTop = (page: number): string => `[${pageId(page)} 0 R /XYZ 0 792 null]`
  const links = [
    { page: 1, rect: '56 690 360 724', target: `/Dest ${xyzTop(PDF_INTERNAL_LINK_TARGET_PAGE)}` },
    { page: 1, rect: '56 630 360 664', target: '/Dest (no-such-destination)' },
    { page: 1, rect: '56 570 360 604', target: '/A << /S /Named /N /LastPage >>' },
    {
      page: PDF_INTERNAL_LINK_TARGET_PAGE,
      rect: '56 630 360 664',
      target: `/Dest ${xyzTop(PDF_INTERNAL_LINK_SECOND_TARGET_PAGE)}`
    }
  ]
  const lines: Record<number, string[]> = {
    1: ['See section on page 5', 'Broken reference', 'Jump to the last page'],
    [PDF_INTERNAL_LINK_TARGET_PAGE]: ['Page 5 body', 'See page 3']
  }
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: PDF_INTERNAL_LINK_PAGE_COUNT }, (_, index) => `${pageId(index + 1)} 0 R`).join(' ')}] /Count ${PDF_INTERNAL_LINK_PAGE_COUNT} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    // Keeps page objects on odd ids so page n is object 5 + 2(n - 1).
    '<< >>'
  ]
  for (let page = 1; page <= PDF_INTERNAL_LINK_PAGE_COUNT; page += 1) {
    const annotIds = links
      .map((link, index) => (link.page === page ? firstLinkId + index : null))
      .filter((id) => id !== null)
    const annots =
      annotIds.length > 0 ? ` /Annots [${annotIds.map((id) => `${id} 0 R`).join(' ')}]` : ''
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId(page) + 1} 0 R${annots} >>`
    )
    const text = lines[page] ?? [`Page ${page} body`]
    const stream = `BT /F1 24 Tf 60 700 Td 60 TL ${text.map((line) => `(${line}) Tj T*`).join(' ')} ET\n`
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`)
  }
  for (const link of links) {
    objects.push(
      `<< /Type /Annot /Subtype /Link /Rect [${link.rect}] /Border [0 0 0] ${link.target} >>`
    )
  }
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

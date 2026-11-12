export const PDF_INTERNAL_LINK_PAGE_COUNT = 6
export const PDF_INTERNAL_LINK_TARGET_PAGE = 5

/** A PDF whose first page links to the top of page 5, like a LaTeX \ref. */
export function createPdfInternalLinkFixture(): Buffer {
  const pageIds = Array.from({ length: PDF_INTERNAL_LINK_PAGE_COUNT }, (_, index) => 5 + index * 2)
  const targetPageId = pageIds[PDF_INTERNAL_LINK_TARGET_PAGE - 1]
  const linkId = 5 + PDF_INTERNAL_LINK_PAGE_COUNT * 2
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${PDF_INTERNAL_LINK_PAGE_COUNT} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    // Keeps page objects on odd ids so page n is object 5 + 2(n - 1).
    '<< >>'
  ]
  for (let page = 1; page <= PDF_INTERNAL_LINK_PAGE_COUNT; page += 1) {
    const annots = page === 1 ? ` /Annots [${linkId} 0 R]` : ''
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${6 + (page - 1) * 2} 0 R${annots} >>`
    )
    const text = page === 1 ? 'See section on page 5' : `Page ${page} body`
    const stream = `BT /F1 24 Tf 60 700 Td (${text}) Tj ET\n`
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`)
  }
  objects.push(
    `<< /Type /Annot /Subtype /Link /Rect [56 690 360 724] /Border [0 0 0] /Dest [${targetPageId} 0 R /XYZ 0 792 null] >>`
  )
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

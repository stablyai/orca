import { serializePdfObjects } from './pdf-find-fixture'

/** One page whose only line of text is a /GoToR link to `targetRelativePath`. */
export function createPdfRelativeLinkFixture(targetRelativePath: string): Buffer {
  const stream = 'BT /F1 20 Tf 60 700 Td (Open the cited paper) Tj ET\n'
  return serializePdfObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    `<< /Type /Annot /Subtype /Link /Rect [60 690 300 725] /Border [0 0 0] /A << /S /GoToR /F (${targetRelativePath}) /D [0 /Fit] >> >>`
  ])
}

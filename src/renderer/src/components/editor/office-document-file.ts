const OFFICE_DOCUMENT_EXTENSION_PATTERN = /\.(?:docx|pptx|xlsx)$/i

export function isOfficeDocumentPath(filePath: string): boolean {
  return OFFICE_DOCUMENT_EXTENSION_PATTERN.test(filePath)
}

export function getOfficeDocumentExtension(filePath: string): 'docx' | 'pptx' | 'xlsx' | null {
  const extension = filePath.split('.').pop()?.toLowerCase()
  return extension === 'docx' || extension === 'pptx' || extension === 'xlsx' ? extension : null
}

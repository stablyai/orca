// Why: files.open used to answer opened:false for a PDF. An already-installed mobile client
// treats opened:true as "activate the synced file tab", then files.read rejects the PDF.
export const FILES_PDF_DESKTOP_OPEN_RUNTIME_CAPABILITY = 'files.open.pdf-desktop.v1' as const

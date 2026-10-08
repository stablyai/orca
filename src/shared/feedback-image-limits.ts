/**
 * Attachment limits for the Send Feedback lane. Declared once because the
 * renderer's attach affordances and the main process's IPC guard must agree:
 * the renderer's copy is what the user experiences, the main one is what
 * actually protects the request, and a drift between them is a silent 413.
 */

export const MAX_FEEDBACK_IMAGE_COUNT = 4

// Why: https://www.onorca.dev/v1/feedback is a Vercel Function, and those reject
// request bodies over 4.5 MB with 413 FUNCTION_PAYLOAD_TOO_LARGE (orca#22466).
// The ~300 KB below that is nominal headroom for multipart framing and the
// report text, which has no length cap of its own — the text-only fallback in
// main/ipc/feedback.ts is what actually guarantees delivery when it is not enough.
export const MAX_FEEDBACK_IMAGE_TOTAL_BYTES = 4 * 1024 * 1024

// Why: equal to the total today because one screenshot may spend the whole
// budget, but kept separate so the oversized file can be named on its own.
export const MAX_FEEDBACK_IMAGE_BYTES = 4 * 1024 * 1024

// Why: the one status that means "the body was over the host's size limit", as
// opposed to the other shed-the-attachment statuses (a corporate filter's 403,
// an unsupported 415…). Named so the guard above and the copy the user reads
// cannot disagree about what 413 stands for.
export const FEEDBACK_PAYLOAD_TOO_LARGE_STATUS = 413

/** Share renderer attachment limits with main’s IPC guard to prevent drift causing silent 413 failures. */

export const MAX_FEEDBACK_IMAGE_COUNT = 4

// Vercel feedback rejects bodies above 4.5 MB (#22466). ~300 KB headroom covers framing/text only nominally;
// uncapped report text can exceed it, so main/ipc/feedback.ts guarantees delivery through text-only fallback.
export const MAX_FEEDBACK_IMAGE_TOTAL_BYTES = 4 * 1024 * 1024

// One screenshot may spend the total budget; separate this limit to name an oversized file.
export const MAX_FEEDBACK_IMAGE_BYTES = 4 * 1024 * 1024

// 413 uniquely identifies host body-size rejection; other attachment failures include filter 403 or unsupported 415.
export const FEEDBACK_PAYLOAD_TOO_LARGE_STATUS = 413

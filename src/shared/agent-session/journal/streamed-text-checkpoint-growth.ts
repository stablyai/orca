/** The length a streamed reply must reach before its next save: an eighth more, at least 32 characters. */
export function nextStreamedTextCheckpointLength(checkpointLength: number): number {
  return Math.max(checkpointLength + 32, Math.ceil(checkpointLength * 1.125))
}

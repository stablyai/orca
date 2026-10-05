// Not anchored: local IPC prefixes "Error invoking remote method '…': Error: ".
const STATUS_ERROR_PATTERN = /\bError (\d{3}):\s*([\s\S]*)$/

/** Reads the `Error <status>: <details>` shape main gives a failed provider request; null without it. */
export function parseHttpStatusError(message: string): { code: number; details: string } | null {
  const match = STATUS_ERROR_PATTERN.exec(message)
  return match ? { code: Number(match[1]), details: match[2].trim() } : null
}

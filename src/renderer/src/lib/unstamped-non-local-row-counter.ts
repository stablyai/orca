/**
 * Dev counter for rows that reached the store without an owner stamp yet were attributed to a
 * non-local host by inference. Every ingest path stamps through `adoptFromEndpoint`, so this
 * should stay 0; a reader that has to guess a non-local owner reports it here.
 */
let unstampedNonLocalRowCount = 0

export function noteUnstampedNonLocalRow(): void {
  unstampedNonLocalRowCount += 1
}

export function getUnstampedNonLocalRowCount(): number {
  return unstampedNonLocalRowCount
}

export function resetUnstampedNonLocalRowCountForTest(): void {
  unstampedNonLocalRowCount = 0
}

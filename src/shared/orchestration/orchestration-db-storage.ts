/** How much disk this computer's orchestration database uses, for Settings' Reclaim space. */
export type OrchestrationDbStorage = {
  databaseBytes: number
  /** Free pages inside the file; only a full rewrite returns them when the file cannot shrink itself. */
  reclaimableBytes: number
  /** The file returns free pages on its own, so Reclaim space has nothing left to do. */
  shrinksItself: boolean
}

/** The rewrite runs while Orca restarts; it is refused up front when the disk lacks room for it. */
export type OrchestrationDbReclaimRequest =
  | { ok: true }
  | { ok: false; neededBytes: number; freeBytes: number }

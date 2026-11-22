export type PtyCreationDisposition =
  | { kind: 'no-fork' }
  | { kind: 'unknown'; recover?: () => Promise<void> }
  // Exact native call threw without exporting a handle; physical outcome is unknown.
  | { kind: 'failed'; completion: Promise<void>; recover?: () => Promise<void> }
  | {
      kind: 'physical'
      completion: Promise<void>
      exitCode: () => number | null
      recover?: () => Promise<void>
    }

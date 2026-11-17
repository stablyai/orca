// Zod-free so the CLI's eager help graph can read it without loading the wire schemas.
export const ORCA_CLOUD_SANDBOX_SPEC = { vcpus: 8, memoryGb: 16 } as const

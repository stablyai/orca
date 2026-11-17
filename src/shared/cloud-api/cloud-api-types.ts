// Orca Cloud programmatic access. API keys, connected apps and routines are managed in the web
// console; the desktop keeps only the availability probe. The routine wire shapes the CLI uses live
// in cloud-api-routine-types.ts.

export type CloudApiAvailability =
  | { status: 'unconfigured' }
  | { status: 'ready'; controlPlaneUrl: string }

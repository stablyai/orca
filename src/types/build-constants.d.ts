// Ambient declarations for compile-time build-identity constants substituted
// by electron-vite's `define` block (see `electron.vite.config.ts` main
// section). Contributor / `pnpm dev` / third-party builds substitute literal
// `null`, which `IS_OFFICIAL_BUILD` in `src/main/telemetry/client.ts`
// evaluates to `false` at module load — such builds console-mirror only.
//
// The CI release workflow (and only the CI release workflow) provides real
// values via GitHub Actions secrets. There is no runtime env-var fallback;
// the substitution happens at compile time so a curious contributor cannot
// spoof transmission with a shell export.

declare const ORCA_BUILD_IDENTITY: 'stable' | 'rc' | null
declare const ORCA_POSTHOG_WRITE_KEY: string | null

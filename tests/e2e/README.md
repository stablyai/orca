# Electron end-to-end tests

Exercises user flows against the built Orca application through Playwright.

Use `tests/playwright.config.ts`; shared launch and fixture helpers live in `helpers/`. Runtime authentication tests belong to [Claude accounts](../../src/main/claude-accounts/README.md).

`agent-profile-settings-sync.unit.test.tsx` and `sleeping-agent-profile-recovery.unit.test.ts` exercise actual host composition and renderer state together under the unit runner. They cover settings notification delivery into mounted controls and captured terminal profile recovery.

`agent-launch-profiles.spec.ts` exercises Claude/Codex folder and literal-alias connections through real IPC, profile editing/unlinking and independent terminal homes after shell startup. `helpers/agent-profile-fixture.ts` stages disposable detected CLIs from `fixtures/profile-agent.cjs`; the native folder picker returns fixture paths. Screenshots use the full application viewport and can be collected outside the checkout with `ORCA_PROFILE_EVIDENCE_DIR`.

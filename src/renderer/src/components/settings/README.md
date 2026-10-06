# Settings components

Renders Orca settings using the [design system](../../../../../docs/STYLEGUIDE.md).

- `SettingsFormControls.tsx`: shared setting rows and controls.
- `AgentsPane.tsx`, `AgentCatalogRow.tsx`: agent availability and launch preferences.
- `AgentLaunchProfiles.tsx`, `AgentProfileForm.tsx`: common Claude/Codex launchers; typed host management owns bindings and `agent-profile-accounts.ts` reuses account enrollment.
- [`agent-profile-settings-sync.unit.test.tsx`](../../../../../tests/e2e/agent-profile-settings-sync.unit.test.tsx): host composition notifications and account enrollment through renderer settings into the mounted list/menu.
- `agents-search.ts`: agent settings search terms.

Settings types live in `../../../../shared/global-settings-types.ts`; launch actions live in `../../lib/`.

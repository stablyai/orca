# Renderer libraries

Connects UI actions to workspace ownership and desktop/runtime APIs.

- `launch-agent-in-new-tab.ts`: workspace agent launch orchestration.
- `sleeping-agent-session-launch.ts`: resumes captured terminal launch settings.
- `agent-profile-workspace-selection.ts`: validates local profile targets before launch.
- `structured-agent-launch-identity.ts`: distinguishes pending provider, host and profile bindings.

Persisted contracts live in [shared](../../../shared/README.md); application state belongs to [store slices](../store/slices/README.md).

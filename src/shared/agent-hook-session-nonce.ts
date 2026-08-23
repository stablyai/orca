// Why: a resumed Codex TUI must prove itself off-screen. Orca stamps this one-shot
// nonce into the single `codex resume` invocation it types, and the managed hook
// echoes it back as the `sessionNonce` form field, so a stale SessionStart from an
// earlier process in the same pane cannot pass for the new one. Deliberately NOT
// `launchToken`: that is pane-lifetime identity and authority attestation matches
// against it, so rotating it per resume would break orchestration dispatch.
export const AGENT_HOOK_SESSION_NONCE_ENV_VAR = 'ORCA_AGENT_SESSION_NONCE'

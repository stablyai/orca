// Renderer-safe DTOs for the audited Codex provider.
//
// PLACEMENT IS THE BOUNDARY. This file is reachable from preload and the
// renderer, so it deliberately contains NO authority: no base URL, no
// Codex-side provider id, no env-var name, no wire API, no registry. All of
// that lives in main/audited-workflow/audited-codex-provider-registry.ts and is
// asserted absent from here by audited-codex-provider-boundary.test.ts.
//
// What may live here is the closed settings-id vocabulary, because
// GlobalSettings, preload, and the renderer all type against it — and a
// settings id is an opaque selector that carries no endpoint and cannot be
// resolved to one outside main.

// Namespace 1 — the renderer/settings selection vocabulary. NOT the value
// passed to Codex as `model_provider`; that is namespace 2 and lives in main.
export const AUDITED_CODEX_SETTINGS_IDS = ['byesu'] as const
export type AuditedCodexSettingsId = (typeof AUDITED_CODEX_SETTINGS_IDS)[number]

/**
 * The provider selection shape.
 *
 * TRANCHE 1: this type ships so GlobalSettings and preload can be typed ahead
 * of the picker, but NOTHING writes it — selection is derived from the presence
 * of the encrypted key record — and sanitizeRendererSettingsUpdate drops the
 * whole field from renderer-originated updates. Persisted selection arrives
 * with the future picker/model change, under its own reviewed contract.
 */
export type AuditedCodexProviderSettings = {
  settingsId: AuditedCodexSettingsId
  model?: string
}

/**
 * What crosses IPC. Two facts, no secret and no endpoint.
 *
 * Both fields derive from ONE durable record (the encrypted key), so they
 * cannot disagree: `settingsId` is non-null exactly when `keyConfigured` is
 * true, for as long as the registry holds a single provider.
 */
export type AuditedCodexProviderStatus = {
  settingsId: AuditedCodexSettingsId | null
  keyConfigured: boolean
}

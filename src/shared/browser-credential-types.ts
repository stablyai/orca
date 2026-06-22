/** Isolated world for the password bridge; mirrors the annotation bridge (1207). */
export const BROWSER_PASSWORD_BRIDGE_WORLD_ID = 1208

/** console.debug message prefix for guest -> host bridge events. */
export const BROWSER_PASSWORD_MESSAGE_PREFIX = '__orca_password_bridge__:'

/** Public entry returned to renderer — NEVER includes the password. */
export type BrowserCredentialEntry = {
  id: string
  origin: string
  hostname: string
  username: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
}

/** On-disk record (adds the safeStorage ciphertext, base64). */
export type StoredBrowserCredential = BrowserCredentialEntry & {
  encryptedPassword: string
}

export type SaveBrowserCredentialArgs = {
  origin: string
  username: string
  password: string
}

export type UpdateBrowserCredentialArgs = {
  id: string
  username?: string
  password?: string
}

export type BrowserCredentialSaveOutcome = 'created' | 'updated' | 'unchanged'

/** Returned by BrowserCredentialVault.importMany — counts for added/skipped/invalid entries. */
export type BrowserCredentialImportSummary = { added: number; skipped: number; invalid: number }

export type BrowserCredentialVaultStatus = {
  available: boolean
  /** Present when available === false (e.g. no OS keyring on Linux). */
  reason?: string
}

/** Bridge -> host event payloads (parsed from console-message). */
export type BrowserPasswordBridgeField = {
  fieldId: string
  rect: { x: number; y: number; width: number; height: number }
}

export type BrowserPasswordDetectEvent = {
  type: 'detect'
  origin: string
  fields: BrowserPasswordBridgeField[]
}

export type BrowserPasswordCaptureEvent = {
  type: 'capture'
  origin: string
  username: string
  password: string
}

export type BrowserPasswordBridgeEvent = BrowserPasswordDetectEvent | BrowserPasswordCaptureEvent

/** A Chromium browser detected as having importable passwords on this machine. */
export type DetectedImportBrowser = {
  family: string
  label: string
  profiles: { name: string; directory: string }[]
  selectedProfile: string
}

/** Result of a password import attempt. */
export type PasswordImportResult =
  | {
      ok: true
      browserLabel: string
      profileLabel: string
      added: number
      skipped: number
      invalid: number
    }
  | { ok: false; reason: string }

export function isBrowserPasswordBridgeEvent(value: unknown): value is BrowserPasswordBridgeEvent {
  if (!value || typeof value !== 'object') {
    return false
  }
  const v = value as Record<string, unknown>
  if (v.type === 'detect') {
    return typeof v.origin === 'string' && Array.isArray(v.fields)
  }
  if (v.type === 'capture') {
    return (
      typeof v.origin === 'string' &&
      typeof v.username === 'string' &&
      typeof v.password === 'string'
    )
  }
  return false
}

/**
 * Contract for Orca's built-in password manager.
 *
 * Trust layout: the guest preload only describes forms and applies a fill it was handed; main owns
 * every secret, origin and save decision; the renderer sees ids, origins and usernames, and a
 * password only after an explicit, re-authenticated reveal in Settings.
 */

/** Global settings the password manager owns; all optional so older profiles load unchanged. */
export type BrowserPasswordsGlobalSettings = {
  /** Experimental switch; absent means off. */
  experimentalBrowserPasswords?: boolean
  /** Advanced: offer to save after a login works; absent means on. */
  browserPasswordsOfferToSave?: boolean
  /** Advanced: confirm with Touch ID before every fill; absent means off. */
  browserPasswordsFillRequiresReauth?: boolean
}

/** Channels the guest preload sends on. The preload writes these out literally (see its test). */
export const BROWSER_PASSWORDS_GUEST_CHANNELS = {
  /** Debounced snapshot of the credential forms currently on the page. */
  pageForms: 'browserPasswords:guest:pageForms',
  /** Provisional capture: the user typed into a credential form. */
  typed: 'browserPasswords:guest:typed',
  /** A submit signal (submit event, Enter, or a click on a submit-like button). */
  submitted: 'browserPasswords:guest:submitted',
  /** The form the user typed into was removed or can no longer take focus. */
  formGone: 'browserPasswords:guest:formGone',
  fieldFocused: 'browserPasswords:guest:fieldFocused',
  fieldBlurred: 'browserPasswords:guest:fieldBlurred',
  fillResult: 'browserPasswords:guest:fillResult'
} as const

/** Channels main sends to the guest preload. */
export const BROWSER_PASSWORDS_TO_GUEST_CHANNELS = {
  /** Turns detection on for this document; until then the preload observes nothing. */
  enable: 'browserPasswords:toGuest:enable',
  /** The setting was turned off: stop observing and reporting. */
  disable: 'browserPasswords:toGuest:disable',
  fill: 'browserPasswords:toGuest:fill'
} as const

export type BrowserPasswordFormKind = 'login' | 'signup' | 'change' | 'username-only'

export type BrowserPasswordGuestRect = { x: number; y: number; width: number; height: number }

/** One credential form as the preload sees it. Never carries values. */
export type BrowserPasswordFormSummary = {
  /** Stable for the life of the document: same form element → same signature. */
  formSignature: string
  kind: BrowserPasswordFormKind
  /** name || id of the classified fields, used to recognise the same form after a failed login. */
  usernameFieldName: string | null
  passwordFieldName: string | null
  /** Resolved absolute action URL, or null for formless/script-submitted forms. */
  action: string | null
}

export type BrowserPasswordGuestPageForms = {
  forms: BrowserPasswordFormSummary[]
}

/** Values the user typed (trusted input only), keyed to the form they came from. */
export type BrowserPasswordGuestCapture = BrowserPasswordFormSummary & {
  username: string | null
  /** Current password for login forms; null for username-only steps. */
  password: string | null
  /** New password for sign-up and change forms. */
  newPassword: string | null
}

export type BrowserPasswordSubmitSource = 'submit' | 'enter' | 'button'

export type BrowserPasswordGuestSubmitted = BrowserPasswordGuestCapture & {
  source: BrowserPasswordSubmitSource
}

export type BrowserPasswordGuestFormGone = { formSignature: string }

export type BrowserPasswordFieldRole = 'username' | 'password' | 'new-password'

export type BrowserPasswordGuestFieldFocused = {
  /** Opaque, per-document handle the preload resolves back to the element on fill. */
  fieldToken: string
  formSignature: string
  role: BrowserPasswordFieldRole
  /** Field box in the guest's CSS pixels, relative to the top-level viewport. */
  rect: BrowserPasswordGuestRect
  /** Guest `innerWidth`, so the renderer can scale guest pixels to pane pixels. */
  viewportWidth: number
}

export type BrowserPasswordGuestFieldBlurred = { fieldToken: string }

export type BrowserPasswordFillRequest = {
  requestId: string
  fieldToken: string
  /** Null when the form has no username field, or it already holds a non-placeholder value. */
  username: string | null
  password: string
}

export type BrowserPasswordFillResult = {
  requestId: string
  ok: boolean
  /** Why the preload refused: field gone, hidden, disabled or readonly, or another account's username is fixed in place. */
  reason?: 'field-gone' | 'not-visible' | 'not-editable' | 'username-mismatch'
}

// ── Renderer ↔ main ────────────────────────────────────────────────────────────

/** Saved login as the renderer may see it: never the password. */
export type BrowserPasswordEntrySummary = {
  id: string
  /** `scheme://host[:port]` of the frame the login was saved from. */
  origin: string
  username: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
}

export type BrowserPasswordSuggestion = {
  entryId: string
  username: string
  origin: string
  /** False when matched by registrable domain only; the dropdown labels these with their origin. */
  exactOrigin: boolean
}

export type BrowserPasswordFieldFocusEvent = {
  browserPageId: string
  fieldToken: string
  role: BrowserPasswordFieldRole
  rect: BrowserPasswordGuestRect
  viewportWidth: number
  suggestions: BrowserPasswordSuggestion[]
}

export type BrowserPasswordFieldBlurEvent = {
  browserPageId: string
  fieldToken: string
}

export type BrowserPasswordSavePromptMode = 'save' | 'update'

export type BrowserPasswordSavePrompt = {
  promptId: string
  browserPageId: string
  origin: string
  username: string
  mode: BrowserPasswordSavePromptMode
}

export type BrowserPasswordSavePromptAction = 'save' | 'never' | 'dismiss'

export type BrowserPasswordSavePromptResponse = {
  promptId: string
  action: BrowserPasswordSavePromptAction
  /** Edited username from the prompt; ignored unless action is 'save'. */
  username?: string
}

export type BrowserPasswordsAvailability =
  | { available: true }
  | { available: false; reason: string }

export type BrowserPasswordImportSummary = {
  imported: number
  /** Already saved with the same password. */
  duplicates: number
  /** Same origin and username already saved with a different password; kept as saved. */
  conflicts: number
  /** Rows without a usable http(s) URL or password. */
  invalid: number
  /** Chromium rows Orca cannot decrypt (Windows app-bound encryption); export a CSV instead. */
  undecryptable: number
}

export type BrowserPasswordImportResult =
  | { ok: true; summary: BrowserPasswordImportSummary }
  | { ok: false; reason: 'canceled' | 'unavailable' | 'failed'; message?: string }

/** What Settings shows for one login after the OS confirmed the user. */
export type BrowserPasswordEntryDetailsResult =
  | { ok: true; password: string; note: string }
  | { ok: false; reason: 'auth-failed' | 'not-found' | 'unavailable' }

export type BrowserPasswordEntryInput = {
  /** A site as typed, e.g. `github.com` or `https://github.com/login`; reduced to its origin. */
  site: string
  username: string
  password: string
  note: string
}

export type BrowserPasswordEntryEditResult =
  | { ok: true }
  | { ok: false; reason: 'invalid-site' | 'invalid-password' | 'duplicate' | 'unavailable' }

/** How the OS confirms the user before a password is shown or copied. */
export type BrowserPasswordReauthMethod = 'touch-id' | 'none'

export type BrowserPasswordsStatus = {
  /** The experimental setting. */
  enabled: boolean
  availability: BrowserPasswordsAvailability
  reauthMethod: BrowserPasswordReauthMethod
}

export type BrowserPasswordCopyResult =
  | { ok: true }
  | { ok: false; reason: 'auth-failed' | 'not-found' | 'unavailable' }

export type BrowserPasswordFillOutcome =
  | BrowserPasswordFillResult
  | { ok: false; reason: 'unavailable' }

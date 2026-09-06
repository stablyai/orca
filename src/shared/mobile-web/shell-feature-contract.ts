/**
 * Behaviors the shell (APK) advertises to the page in `init`, so a page from a newer desktop can
 * tell whether the shell it is running inside understands a payload field before sending it.
 *
 * Grants answer "may the page call this operation"; features answer "will this shell understand
 * this field". They are separate because page->shell payload schemas are `.strict()` — the shell
 * is the authority there, and an ungated new field is a hard `invalid_request` on every older
 * shell, not an ignored key. The shell->page direction needs no such list: `init` is parsed
 * through the tolerant view, which strips keys the page has never heard of.
 *
 * Feature names are opaque strings on the wire, never a zod enum: the tolerant parse only rescues
 * unclassifiable members of an array of unions, so one unknown enum member would fail the whole
 * `init` frame and cost the page every grant it carries.
 */
export const MOBILE_WEB_SHELL_NATIVE_CHAT_PASTE_FOLLOWED_BY_TEXT_FEATURE =
  'nativeChat.pasteImages.followedByText.v1'

export const MOBILE_WEB_SHELL_FEATURES = [
  MOBILE_WEB_SHELL_NATIVE_CHAT_PASTE_FOLLOWED_BY_TEXT_FEATURE
] as const

export type MobileWebShellFeature = (typeof MOBILE_WEB_SHELL_FEATURES)[number]

export const MOBILE_WEB_SHELL_MAX_FEATURES = 64
export const MOBILE_WEB_SHELL_MAX_FEATURE_CHARACTERS = 64

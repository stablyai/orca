/** What the server account row weighs: the form's alert, and whether the picked method needs a
 *  fresh sign-in, from the auth form's action. */
export type AntigravityServerAccountRowInput = {
  /** Gemini API key chats run on agy, which Orca doesn't sign in. */
  noServerAccount: boolean
  alert: string | null
  reauth: boolean
  /** The method id picked in the form. */
  pickedMethod: string
}

/** Where key chats run on agy, the server's account row shows only a failed save's message, or a
 *  sign-in for a method picked here that signs in (not the key, which agy uses as is). */
export function antigravityServerAccountRowShown(input: AntigravityServerAccountRowInput): boolean {
  if (!input.noServerAccount) {
    return true
  }
  return Boolean(input.alert) || (input.reauth && input.pickedMethod !== 'gemini-api-key')
}

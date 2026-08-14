import type { CDPSession } from '@stablyai/playwright-test'

/**
 * Dispatches the key shapes an input source or a system text substitution produces, through CDP.
 *
 * Driving these from the browser protocol rather than a native input source is what removes the
 * accessibility grant and the system input source that would otherwise force a `@headful`,
 * macOS-only gate, so the specs they feed run in the normal headless project on CI.
 */
export type ImeKeyIdentity = {
  key: string
  code: string
  keyCode: number
}

/**
 * A printable keydown whose `key` the input source has already rewritten to the glyph it will
 * commit — the shape a CJK source produces for punctuation and full-width digits, which arrive
 * with no composition session at all.
 */
export async function dispatchImeRewrittenPrintableKey(
  session: CDPSession,
  identity: ImeKeyIdentity
): Promise<void> {
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: identity.key,
    code: identity.code,
    windowsVirtualKeyCode: identity.keyCode,
    nativeVirtualKeyCode: identity.keyCode,
    text: identity.key,
    unmodifiedText: identity.key
  })
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: identity.key,
    code: identity.code,
    windowsVirtualKeyCode: identity.keyCode,
    nativeVirtualKeyCode: identity.keyCode
  })
}

/**
 * A printable keydown that still carries the **physical layout key**, followed by the substituted
 * glyph arriving through the text system.
 *
 * This is the macOS shape for full-width punctuation and digits, and for a
 * `DefaultKeyBinding.dict` remap: the substitution happens inside `insertText:`, not on the
 * keydown, so the keydown Chromium delivers is the plain layout character and the substituted one
 * only ever appears in the `input` event. Anything that produces terminal bytes from the keydown
 * emits the layout form and destroys the real one.
 */
export async function dispatchImeSubstitutedTextKey(
  session: CDPSession,
  identity: ImeKeyIdentity,
  committedText: string
): Promise<void> {
  // rawKeyDown carries no `text`, so Chromium generates no character of its own and the only
  // committed text is the one the text system supplies below.
  await session.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: identity.key,
    code: identity.code,
    windowsVirtualKeyCode: identity.keyCode,
    nativeVirtualKeyCode: identity.keyCode,
    text: '',
    unmodifiedText: ''
  })
  await session.send('Input.insertText', { text: committedText })
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: identity.key,
    code: identity.code,
    windowsVirtualKeyCode: identity.keyCode,
    nativeVirtualKeyCode: identity.keyCode
  })
}

export async function dispatchPlainEnter(session: CDPSession): Promise<void> {
  for (const type of ['rawKeyDown', 'keyUp'] as const) {
    await session.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    })
  }
}

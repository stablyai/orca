import type { CDPSession, Page } from '@stablyai/playwright-test'

// Dispatch input-source/text-substitution key shapes through CDP so headless CI needs no native IME or accessibility grant.
export type ImeKeyIdentity = {
  key: string
  code: string
  keyCode: number
}

// Some CJK sources rewrite keydown.key to the committed punctuation/full-width digit without any composition session.
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

// macOS full-width input and DefaultKeyBinding.dict remaps keep the physical layout key on keydown and substitute via insertText:.
// Emitting terminal bytes from keydown sends the layout form and destroys the later committed glyph.
export async function dispatchImeSubstitutedTextKey(
  session: CDPSession,
  identity: ImeKeyIdentity,
  committedText: string
): Promise<void> {
  // rawKeyDown supplies no text, leaving the following text-system commit as the only insertion.
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

/** Same direct commit shape, with Chromium's composing bit set on the idle Process keydown. */
export async function dispatchImeIdleComposingTextKey(
  page: Page,
  identity: ImeKeyIdentity,
  committedText: string
): Promise<void> {
  await page.evaluate(
    ({ identity: key, committedText: text }) => {
      const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea:focus')
      if (!textarea) {
        throw new Error('xterm helper textarea is not focused')
      }
      const event = new KeyboardEvent('keydown', {
        key: 'Process',
        code: key.code,
        bubbles: true,
        cancelable: true,
        isComposing: true
      })
      Object.defineProperty(event, 'keyCode', { value: key.keyCode })
      textarea.dispatchEvent(event)
      textarea.value = text
      const input = new InputEvent('input', { bubbles: true, composed: true, data: text })
      Object.defineProperty(input, 'inputType', { value: 'insertText' })
      textarea.dispatchEvent(input)
      textarea.dispatchEvent(
        new KeyboardEvent('keyup', {
          key: 'Process',
          code: key.code,
          bubbles: true,
          cancelable: true,
          isComposing: false
        })
      )
    },
    { identity, committedText }
  )
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

// imeSetComposition opens a real Chromium composition session for native-IME-free preedit geometry checks.
export async function setImeComposition(
  session: CDPSession,
  text: string,
  selection?: { start: number; end: number }
): Promise<void> {
  const length = Array.from(text).length
  await session.send('Input.imeSetComposition', {
    text,
    selectionStart: selection?.start ?? length,
    selectionEnd: selection?.end ?? length
  })
}

export async function commitImeText(session: CDPSession, text: string): Promise<void> {
  await session.send('Input.insertText', { text })
}

/** IME preedit keystrokes reach the renderer as VK_PROCESSKEY (229) with no text payload. */
export async function dispatchImeProcessKey(
  session: CDPSession,
  identity: Pick<ImeKeyIdentity, 'key' | 'code'>
): Promise<void> {
  for (const type of ['rawKeyDown', 'keyUp'] as const) {
    await session.send('Input.dispatchKeyEvent', {
      type,
      key: identity.key,
      code: identity.code,
      windowsVirtualKeyCode: 229,
      nativeVirtualKeyCode: 229,
      text: '',
      unmodifiedText: ''
    })
  }
}

/** Drives one syllable's jamo frames; `pauseMs` 0 models key repeat reaching the renderer. */
export async function composeHangulSyllable(
  session: CDPSession,
  page: Page,
  frames: readonly { jamoKey: ImeKeyIdentity; preedit: string }[],
  pauseMs = 60
): Promise<void> {
  for (const frame of frames) {
    await dispatchImeProcessKey(session, frame.jamoKey)
    await setImeComposition(session, frame.preedit)
    if (pauseMs > 0) {
      await page.waitForTimeout(pauseMs)
    }
  }
}

// Synthesize a compositionupdate without compositionstart: xterm’s update writes text but only start adds .active.
// The Windows/WSL fixture has all 37 updates inside start/end pairs; CDP also always opens a session, so neither can supply this ordering.
export async function dispatchResumedCompositionUpdate(page: Page, data: string): Promise<void> {
  await page.evaluate((preedit: string) => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea:focus')
    if (!textarea) {
      throw new Error('xterm helper textarea is not focused')
    }
    textarea.dispatchEvent(
      new CompositionEvent('compositionupdate', {
        bubbles: true,
        data: preedit
      })
    )
    textarea.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        composed: true,
        data: preedit,
        inputType: 'insertCompositionText',
        isComposing: true
      })
    )
  }, data)
}

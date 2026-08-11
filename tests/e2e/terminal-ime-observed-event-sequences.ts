import type { Page } from '@stablyai/playwright-test'

async function dispatchObservedIbusHangulSequence(
  page: Page,
  variant: 'mixed' | 'retained'
): Promise<void> {
  await page.evaluate((selectedVariant) => {
    const textarea = document.activeElement
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error('xterm helper textarea is not focused')
    }
    const composition = (type: string, data = ''): void => {
      textarea.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }))
    }
    const input = (type: 'beforeinput' | 'input', inputType: string, data?: string): void => {
      textarea.dispatchEvent(
        new InputEvent(type, {
          bubbles: true,
          cancelable: type === 'beforeinput',
          composed: true,
          data: data ?? null,
          inputType
        })
      )
    }
    const replaceAndInput = (value: string, inputType: string, data?: string): void => {
      input('beforeinput', inputType, data)
      textarea.value = value
      input('input', inputType, data)
    }
    const keydown = (key: string, code: string, keyCode: number, isComposing = false): void => {
      const event = new KeyboardEvent('keydown', { bubbles: true, code, isComposing, key })
      Object.defineProperty(event, 'keyCode', { value: keyCode })
      textarea.dispatchEvent(event)
    }
    const update = (prefix: string, text: string): void => {
      composition('compositionupdate', text)
      replaceAndInput(`${prefix}${text}`, 'insertCompositionText', text)
    }
    const begin = (text: string): string => {
      const prefix = textarea.value
      textarea.setSelectionRange(prefix.length, prefix.length)
      composition('compositionstart')
      keydown('Process', 'KeyG', 229, true)
      update(prefix, text)
      return prefix
    }
    const end = (prefix: string): void => {
      composition('compositionupdate')
      replaceAndInput(prefix, 'deleteContentBackward')
      composition('compositionend')
    }
    const commit = (prefix: string, text: string): void => {
      end(prefix)
      replaceAndInput(`${prefix}${text}`, 'insertText', text)
    }

    if (selectedVariant === 'mixed') {
      let prefix = begin('한')
      commit(prefix, '한')
      for (const character of 'abc') {
        keydown(character, `Key${character.toUpperCase()}`, character.charCodeAt(0))
        replaceAndInput(`${textarea.value}${character}`, 'insertText', character)
      }
      prefix = begin('글')
      commit(prefix, '글')
      keydown('Enter', 'Enter', 13)
      return
    }

    const prefix = begin('테')
    composition('compositionend', '테')
    keydown('a', 'KeyA', 65)
    keydown('Process', 'KeyR', 229, true)
    textarea.setSelectionRange(prefix.length + 1, prefix.length + 1)
    composition('compositionstart')
    update(`${prefix}테`, '스')
    composition('compositionend', '스')
    keydown('Enter', 'Enter', 13)
  }, variant)
}

export async function dispatchObservedIbusHangulMixedSequence(page: Page): Promise<void> {
  await dispatchObservedIbusHangulSequence(page, 'mixed')
}

export async function dispatchObservedIbusHangulRetainedCommitSequence(page: Page): Promise<void> {
  await dispatchObservedIbusHangulSequence(page, 'retained')
}

// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildTerminalIosTextEditPayload,
  computeTerminalIosTextEditStep,
  installTerminalIosTextEditMirror
} from './terminal-ios-text-edit-mirror'

const DEL = '\x7f'

/**
 * Field values observed on iPadOS 26.5.2 with a hardware 2-set Korean keyboard
 * while typing `한글깨짐`, one entry per `input` event. The system fires no
 * composition events: it deletes the trailing syllable and reinserts the
 * updated one. Note the `ㅣ` step — one deletion, two characters back.
 */
const IPADOS_HANGUL_FIELD_SEQUENCE = [
  'ㅎ',
  '',
  '하',
  '',
  '한',
  '한ㄱ',
  '한',
  '한그',
  '한',
  '한글',
  '한글ㄲ',
  '한글',
  '한글깨',
  '한글',
  '한글깾',
  '한글',
  '한글깨지',
  '한글깨',
  '한글깨짐'
] as const

/** Applies PTY bytes the way a line editor does, so the test asserts what the user ends up seeing. */
function applyTerminalPayload(buffer: string, payload: string): string {
  let result = Array.from(buffer)
  for (const char of Array.from(payload)) {
    if (char === DEL) {
      result = result.slice(0, -1)
    } else {
      result.push(char)
    }
  }
  return result.join('')
}

const openContainers: HTMLElement[] = []

function openMirror(): {
  textarea: HTMLTextAreaElement
  sent: string[]
  mirror: ReturnType<typeof installTerminalIosTextEditMirror>
} {
  const container = document.createElement('div')
  const textarea = document.createElement('textarea')
  textarea.classList.add('xterm-helper-textarea')
  container.appendChild(textarea)
  document.body.appendChild(container)
  openContainers.push(container)
  const sent: string[] = []
  const mirror = installTerminalIosTextEditMirror({
    terminalElement: container,
    sendInput: (data) => sent.push(data)
  })
  return { textarea, sent, mirror }
}

function typeIntoField(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

afterEach(() => {
  for (const container of openContainers.splice(0)) {
    container.remove()
  }
})

describe('computeTerminalIosTextEditStep', () => {
  it('appends without erasing when the field only grew', () => {
    expect(computeTerminalIosTextEditStep('한글', '한글깨')).toEqual({
      eraseCount: 0,
      appendText: '깨'
    })
  })

  it('erases the diverging tail before appending the replacement', () => {
    expect(computeTerminalIosTextEditStep('하', '한')).toEqual({ eraseCount: 1, appendText: '한' })
  })

  it('handles a replacement that is longer than what it replaced', () => {
    // Why: typing ㅣ after 깾 emits one deleteContentBackward and reinserts two characters.
    expect(computeTerminalIosTextEditStep('한글깾', '한글깨지')).toEqual({
      eraseCount: 1,
      appendText: '깨지'
    })
  })

  it('counts erasures in code points, not UTF-16 units', () => {
    expect(computeTerminalIosTextEditStep('가😀', '가')).toEqual({ eraseCount: 1, appendText: '' })
  })

  it('emits nothing when the field is unchanged', () => {
    expect(computeTerminalIosTextEditStep('한글', '한글')).toEqual({
      eraseCount: 0,
      appendText: ''
    })
  })
})

describe('buildTerminalIosTextEditPayload', () => {
  it('sends one DEL per erased code point ahead of the replacement', () => {
    expect(buildTerminalIosTextEditPayload({ eraseCount: 2, appendText: '글' })).toBe(
      `${DEL}${DEL}글`
    )
  })

  it('is empty when there is nothing to erase or append', () => {
    expect(buildTerminalIosTextEditPayload({ eraseCount: 0, appendText: '' })).toBe('')
  })
})

describe('installTerminalIosTextEditMirror', () => {
  it('reproduces the recorded iPadOS sequence as composed syllables', () => {
    const { textarea, sent } = openMirror()
    for (const value of IPADOS_HANGUL_FIELD_SEQUENCE) {
      typeIntoField(textarea, value)
    }
    const rendered = sent.reduce(applyTerminalPayload, '')
    expect(rendered).toBe('한글깨짐')
  })

  it('never leaves a lone jamo as the final PTY state', () => {
    const { textarea, sent } = openMirror()
    for (const value of IPADOS_HANGUL_FIELD_SEQUENCE) {
      typeIntoField(textarea, value)
    }
    const rendered = sent.reduce(applyTerminalPayload, '')
    const compatibilityJamo = Array.from(rendered).filter((char) => {
      const codePoint = char.codePointAt(0) ?? 0
      return codePoint >= 0x3130 && codePoint <= 0x318f
    })
    expect(compatibilityJamo).toEqual([])
  })

  it('stops the input event so xterm cannot send the same text again', () => {
    const { textarea } = openMirror()
    let reachedTextareaListener = false
    textarea.addEventListener('input', () => {
      reachedTextareaListener = true
    })
    typeIntoField(textarea, 'ㅎ')
    expect(reachedTextareaListener).toBe(false)
  })

  it('ignores input events from other fields inside the pane, such as terminal search', () => {
    const { textarea, sent } = openMirror()
    const searchField = document.createElement('input')
    searchField.value = 'unrelated'
    textarea.parentElement?.appendChild(searchField)
    searchField.dispatchEvent(new Event('input', { bubbles: true }))
    expect(sent).toEqual([])
  })

  it('reset clears the field so the next edit does not replay sent text', () => {
    const { textarea, sent, mirror } = openMirror()
    typeIntoField(textarea, '한')
    mirror.reset()
    expect(textarea.value).toBe('')
    typeIntoField(textarea, '글')
    expect(sent).toEqual(['한', '글'])
  })

  it('reset on blur keeps a refocused pane from erasing text the PTY still holds', () => {
    const { textarea, sent } = openMirror()
    typeIntoField(textarea, '한')
    textarea.dispatchEvent(new Event('blur', { bubbles: true }))
    typeIntoField(textarea, '글')
    expect(sent).toEqual(['한', '글'])
  })

  it('stands aside for input sources that do run a composition session', () => {
    // Why: the iPad on-screen keyboard and the Japanese/Chinese IMEs compose
    // normally; xterm commits those by reading the field, so mirroring them
    // would send the same text twice.
    const { textarea, sent } = openMirror()
    let reachedTextareaListener = false
    textarea.addEventListener('input', () => {
      reachedTextareaListener = true
    })
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    typeIntoField(textarea, 'に')
    typeIntoField(textarea, 'にほ')
    expect(sent).toEqual([])
    expect(reachedTextareaListener).toBe(true)
  })

  it('resumes mirroring after the composition session ends', async () => {
    const { textarea, sent } = openMirror()
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    typeIntoField(textarea, 'にほん')
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    await Promise.resolve()
    // Why: xterm already sent the composed text, so the next diff must start empty.
    typeIntoField(textarea, 'にほんㅎ')
    expect(sent).toEqual(['にほんㅎ'])
  })

  it('reports when it is the one writing, so external PTY writes can be told apart', () => {
    const container = document.createElement('div')
    const textarea = document.createElement('textarea')
    textarea.classList.add('xterm-helper-textarea')
    container.appendChild(textarea)
    document.body.appendChild(container)
    openContainers.push(container)
    const mirroringDuringSend: boolean[] = []
    const mirror = installTerminalIosTextEditMirror({
      terminalElement: container,
      sendInput: () => mirroringDuringSend.push(mirror.isMirroring())
    })
    typeIntoField(textarea, 'ㅎ')
    expect(mirroringDuringSend).toEqual([true])
    expect(mirror.isMirroring()).toBe(false)
  })

  it('ignores blur from other elements in the pane', () => {
    const { textarea, sent } = openMirror()
    typeIntoField(textarea, '한')
    const searchField = document.createElement('input')
    textarea.parentElement?.appendChild(searchField)
    searchField.dispatchEvent(new Event('blur', { bubbles: true }))
    expect(textarea.value).toBe('한')
    typeIntoField(textarea, '한글')
    expect(sent).toEqual(['한', '글'])
  })

  it('stops mirroring once disposed', () => {
    const { textarea, sent, mirror } = openMirror()
    mirror.dispose()
    typeIntoField(textarea, 'ㅎ')
    expect(sent).toEqual([])
  })

  it('is inert without a terminal element', () => {
    const mirror = installTerminalIosTextEditMirror({
      terminalElement: null,
      sendInput: () => {
        throw new Error('should not send')
      }
    })
    expect(() => mirror.reset()).not.toThrow()
    expect(() => mirror.dispose()).not.toThrow()
  })
})

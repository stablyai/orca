import { describe, expect, it, vi } from 'vitest'
import { copyClipboardTextViaExecCommand } from './web-clipboard-copy-fallback'

type FakeTextarea = {
  value: string
  readOnly: boolean
  style: Record<string, string>
  select: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
}

function createFakeDocument(options?: {
  execCommandResult?: boolean
  execCommandThrows?: boolean
}) {
  const textarea: FakeTextarea = {
    value: '',
    readOnly: false,
    style: {},
    select: vi.fn(),
    remove: vi.fn()
  }
  const previousFocus = { focus: vi.fn() }
  const execCommand = vi.fn((command: string) => {
    if (options?.execCommandThrows) {
      throw new Error('execCommand denied')
    }
    return command === 'copy' ? (options?.execCommandResult ?? true) : false
  })
  const doc = {
    activeElement: previousFocus,
    createElement: vi.fn(() => textarea),
    execCommand,
    body: { appendChild: vi.fn() }
  } as unknown as Document
  return { doc, textarea, previousFocus, execCommand }
}

describe('copyClipboardTextViaExecCommand', () => {
  it('copies text through a temporary textarea selection', () => {
    const { doc, textarea, execCommand } = createFakeDocument()

    expect(copyClipboardTextViaExecCommand('terminal selection', doc)).toBe(true)
    expect(textarea.value).toBe('terminal selection')
    expect(textarea.select).toHaveBeenCalled()
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('removes the helper textarea and restores focus after copying', () => {
    const { doc, textarea, previousFocus } = createFakeDocument()

    copyClipboardTextViaExecCommand('copy me', doc)

    expect(textarea.remove).toHaveBeenCalled()
    expect(previousFocus.focus).toHaveBeenCalled()
  })

  it('returns false when execCommand reports failure', () => {
    const { doc, textarea } = createFakeDocument({ execCommandResult: false })

    expect(copyClipboardTextViaExecCommand('copy me', doc)).toBe(false)
    expect(textarea.remove).toHaveBeenCalled()
  })

  it('returns false and still cleans up when execCommand throws', () => {
    const { doc, textarea, previousFocus } = createFakeDocument({ execCommandThrows: true })

    expect(copyClipboardTextViaExecCommand('copy me', doc)).toBe(false)
    expect(textarea.remove).toHaveBeenCalled()
    expect(previousFocus.focus).toHaveBeenCalled()
  })

  it('returns false when the document has no execCommand', () => {
    const doc = { body: {} } as unknown as Document

    expect(copyClipboardTextViaExecCommand('copy me', doc)).toBe(false)
  })
})

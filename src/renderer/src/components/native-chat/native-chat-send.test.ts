import { describe, expect, it } from 'vitest'
import { NATIVE_CHAT_SUPPORTED_AGENT_LIST } from '../../../../shared/native-chat-agent-support'
import { getNativeChatAttachmentForm } from '../../../../shared/native-chat-agent-profiles'
import { getAgentImageHandling } from './native-chat-image-paste'
import {
  buildNativeChatAttachmentBytes,
  buildNativeChatAttachmentWrites,
  buildNativeChatPasteBytes,
  buildNativeChatSendBytes,
  isMultilineDraft,
  NATIVE_CHAT_SUBMIT
} from './native-chat-send'

const BEGIN = '\x1b[200~'
const END = '\x1b[201~'

describe('NATIVE_CHAT_SUBMIT', () => {
  it('is a bare carriage return so the Enter write is unambiguous', () => {
    expect(NATIVE_CHAT_SUBMIT).toBe('\r')
  })
})

describe('buildNativeChatPasteBytes', () => {
  it('single-line text has no trailing submit (Enter is written separately)', () => {
    expect(buildNativeChatPasteBytes('hello world')).toBe('hello world')
    expect(buildNativeChatPasteBytes('hello world')).not.toContain('\r')
  })

  it('multi-line text is bracketed-paste wrapped with NO trailing submit', () => {
    const text = 'line one\r\nline two\nline three'
    expect(buildNativeChatPasteBytes(text)).toBe(`${BEGIN}line one\rline two\rline three${END}`)
  })

  it('treats a trailing newline as multi-line', () => {
    expect(buildNativeChatPasteBytes('a\n')).toBe(`${BEGIN}a\r${END}`)
  })

  it('sanitizes an embedded bracketed-paste end and bare ESC before framing', () => {
    const malicious = 'before\nmid\x1b[201~ rm -rf /\x1b tail'
    const bytes = buildNativeChatPasteBytes(malicious)
    expect(bytes.startsWith(BEGIN)).toBe(true)
    expect(bytes.endsWith(END)).toBe(true)
    const inner = bytes.slice(BEGIN.length, bytes.length - END.length)
    expect(inner).not.toContain('\x1b')
    expect(inner).toContain('␛[201~')
  })

  it('neutralizes a stray ESC in the single-line branch', () => {
    expect(buildNativeChatPasteBytes('hi\x1b there')).toBe('hi␛ there')
  })
})

describe('buildNativeChatAttachmentBytes', () => {
  it('bracket-pastes the image path for agents that attach a pasted path', () => {
    expect(buildNativeChatAttachmentBytes('/tmp/orca-paste-image.png', 'image-paste')).toBe(
      `${BEGIN}/tmp/orca-paste-image.png${END}`
    )
  })

  it('sanitizes embedded escape bytes before framing', () => {
    expect(buildNativeChatAttachmentBytes('/tmp/before\x1b[201~after.png', 'image-paste')).toBe(
      `${BEGIN}/tmp/before␛[201~after.png${END}`
    )
  })

  it('sends an unframed @path for agents with no image-paste gesture', () => {
    expect(buildNativeChatAttachmentBytes('/tmp/orca-paste-image.png', 'file-reference')).toBe(
      '@/tmp/orca-paste-image.png'
    )
  })

  it('quotes a spaced path and sanitizes escape bytes in the reference form', () => {
    expect(buildNativeChatAttachmentBytes('C:\\My Shots\\a.png', 'file-reference')).toBe(
      '@"C:\\My Shots\\a.png"'
    )
    expect(buildNativeChatAttachmentBytes('/tmp/a\x1b[201~b.png', 'file-reference')).toBe(
      '@/tmp/a␛[201~b.png'
    )
  })

  // An unframed write is keystrokes: a CR in a filename would submit the turn.
  it('frames a reference whose path carries a line break instead of writing a bare CR', () => {
    expect(buildNativeChatAttachmentBytes('/tmp/a\nb.png', 'file-reference')).toBe(
      `${BEGIN}@"/tmp/a\rb.png"${END}`
    )
    expect(buildNativeChatAttachmentBytes('/tmp/a\rb.png', 'file-reference')).toBe(
      `${BEGIN}@"/tmp/a\rb.png"${END}`
    )
  })

  // The A1 regression: two Native-Chat agents must not share one attachment form.
  it('emits a different form for an unverified agent than for Claude', () => {
    const path = '/tmp/shot.png'
    expect(buildNativeChatAttachmentBytes(path, getNativeChatAttachmentForm('claude'))).not.toBe(
      buildNativeChatAttachmentBytes(path, getNativeChatAttachmentForm('omp'))
    )
  })

  // Expected bytes are literal, not derived from the function under test, so a
  // table flip that made every agent agree would fail here.
  it.each([
    ['claude', `${BEGIN}/tmp/shot.png${END}`],
    ['openclaude', `${BEGIN}/tmp/shot.png${END}`],
    ['codex', `${BEGIN}/tmp/shot.png${END}`],
    ['grok', `${BEGIN}/tmp/shot.png${END}`],
    ['omp', '@/tmp/shot.png']
  ] as const)('%s attaches /tmp/shot.png as %s', (agent, expected) => {
    expect(
      buildNativeChatAttachmentBytes('/tmp/shot.png', getNativeChatAttachmentForm(agent))
    ).toBe(expected)
  })

  it('covers every native-chat agent in the table above', () => {
    expect([...NATIVE_CHAT_SUPPORTED_AGENT_LIST].sort()).toEqual(
      ['claude', 'codex', 'grok', 'omp', 'openclaude'].sort()
    )
  })
})

describe('buildNativeChatAttachmentWrites', () => {
  it('leaves back-to-back image frames bare and separates only the last from text', () => {
    expect(
      buildNativeChatAttachmentWrites(['/tmp/a.png', '/tmp/b.png'], 'image-paste', true)
    ).toEqual([`${BEGIN}/tmp/a.png${END}`, `${BEGIN}/tmp/b.png${END} `])
    expect(
      buildNativeChatAttachmentWrites(['/tmp/a.png', '/tmp/b.png'], 'image-paste', false)
    ).toEqual([`${BEGIN}/tmp/a.png${END}`, `${BEGIN}/tmp/b.png${END}`])
  })

  it('separates every @path reference, which is not self-delimiting', () => {
    expect(
      buildNativeChatAttachmentWrites(['/tmp/a.png', '/tmp/b.png'], 'file-reference', true)
    ).toEqual(['@/tmp/a.png ', '@/tmp/b.png '])
    expect(
      buildNativeChatAttachmentWrites(['/tmp/a.png', '/tmp/b.png'], 'file-reference', false)
    ).toEqual(['@/tmp/a.png ', '@/tmp/b.png'])
  })

  it('writes nothing when there are no attachments', () => {
    expect(buildNativeChatAttachmentWrites([], 'file-reference', true)).toEqual([])
  })
})

describe('buildNativeChatSendBytes', () => {
  it('single-line text sends as text + carriage return', () => {
    expect(buildNativeChatSendBytes('hello world')).toBe('hello world\r')
  })

  it('multi-line text is bracketed-paste wrapped then submitted', () => {
    const text = 'line one\nline two'
    expect(buildNativeChatSendBytes(text)).toBe(`${BEGIN}line one\rline two${END}\r`)
  })

  it('treats a trailing newline as multi-line', () => {
    expect(buildNativeChatSendBytes('a\n')).toBe(`${BEGIN}a\r${END}\r`)
  })

  it('handles CR-style line breaks as multi-line', () => {
    expect(buildNativeChatSendBytes('a\rb')).toBe(`${BEGIN}a\rb${END}\r`)
  })

  it('sanitizes an embedded bracketed-paste end and bare ESC before framing', () => {
    // A pasted scrollback line could carry its own `\x1b[201~` which would
    // otherwise close the frame early and run the tail as keystrokes.
    const malicious = 'before\nmid\x1b[201~ rm -rf /\x1b tail'
    const bytes = buildNativeChatSendBytes(malicious)
    // No raw ESC survives the sanitize, so the only `\x1b` bytes are the frame.
    expect(bytes.startsWith(BEGIN)).toBe(true)
    expect(bytes.endsWith(`${END}\r`)).toBe(true)
    const inner = bytes.slice(BEGIN.length, bytes.length - END.length - 1)
    expect(inner).not.toContain('\x1b')
    expect(inner).toContain('␛[201~')
  })

  it('neutralizes a stray ESC in the single-line branch', () => {
    const bytes = buildNativeChatSendBytes('hi\x1b there')
    expect(bytes).toBe('hi␛ there\r')
    expect(bytes).not.toContain('\x1b')
  })
})

describe('isMultilineDraft', () => {
  it('is false for single-line', () => {
    expect(isMultilineDraft('one line')).toBe(false)
  })
  it('is true when a newline is present', () => {
    expect(isMultilineDraft('a\nb')).toBe(true)
  })
})

// Two per-agent tables answer "does this agent attach a pasted path?": the send
// side's attachmentForm and the clipboard side's IMAGE_ATTACHMENT_AGENTS. They
// must agree, or a drop and a paste of the same image reach the agent differently.
describe('attachment form agrees with clipboard image handling', () => {
  it.each(NATIVE_CHAT_SUPPORTED_AGENT_LIST)('%s', (agent) => {
    const acceptsPastedPath = getAgentImageHandling(agent) === 'attachment'
    expect(getNativeChatAttachmentForm(agent)).toBe(
      acceptsPastedPath ? 'image-paste' : 'file-reference'
    )
  })
})

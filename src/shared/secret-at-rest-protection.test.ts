import { describe, expect, it } from 'vitest'
import { classifyUnenvelopedCredential } from './secret-at-rest-protection'

describe('classifyUnenvelopedCredential', () => {
  it.each([
    ['a bare API key', 'sk-abcdef0123456789'],
    ['a Bitbucket app password', 'ATBB3xYzQq_example-token'],
    ['a JSON credential blob', '{"username":"me","password":"hunter2"}'],
    ['a token with newlines a user pasted', 'sk-abc\ndef\n']
  ])('reports %s as plaintext', (_label, token) => {
    expect(classifyUnenvelopedCredential(Buffer.from(token, 'utf8'))).toBe('plaintext')
  })

  it('reports a macOS v10 keychain blob as sealed', () => {
    // Prefix Electron writes on macOS, followed by binary ciphertext.
    const sealed = Buffer.concat([
      Buffer.from('v10', 'utf8'),
      Buffer.from([0x00, 0x91, 0xf2, 0x1a, 0x7c, 0x03, 0xff, 0xfe])
    ])
    expect(classifyUnenvelopedCredential(sealed)).toBe('sealed')
  })

  it('reports arbitrary ciphertext bytes as sealed', () => {
    const sealed = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x1f])
    expect(classifyUnenvelopedCredential(sealed)).toBe('sealed')
  })

  // Why this case: tabs and newlines are legal in a pasted token, so treating every
  // control byte as ciphertext would warn on nothing and stay silent on real plaintext.
  it('does not mistake tabs or CRLF in a token for ciphertext', () => {
    expect(classifyUnenvelopedCredential(Buffer.from('token\tmore\r\n', 'utf8'))).toBe('plaintext')
  })

  it('reports empty bytes as plaintext rather than claiming protection', () => {
    expect(classifyUnenvelopedCredential(Buffer.alloc(0))).toBe('plaintext')
  })
})

import { describe, expect, it } from 'vitest'
import { classifySshErrorCategory } from './ssh-error-category'

// The table is first-match-wins over an ordered list, so every case here is really
// a test of ORDER. Reordering it is invisible to types and to every other suite.
describe('classifySshErrorCategory', () => {
  it('returns null for non-strings and empty strings', () => {
    expect(classifySshErrorCategory(null)).toBeNull()
    expect(classifySshErrorCategory(undefined)).toBeNull()
    expect(classifySshErrorCategory(42)).toBeNull()
    expect(classifySshErrorCategory('')).toBeNull()
  })

  it.each([
    ['getaddrinfo ENOTFOUND bastion', 'dns'],
    ['ssh: Could not resolve hostname prod-db: Name or service not known', 'dns'],
    ['Enter passphrase for key /home/u/.ssh/id_rsa', 'passphrase'],
    ['Host key verification failed.', 'host-key'],
    ['@@@ REMOTE HOST IDENTIFICATION HAS CHANGED! @@@', 'host-key'],
    ['connect ECONNREFUSED 10.0.0.1:22', 'refused'],
    ['ssh: connect to host box port 22: No route to host', 'unreachable'],
    ['ssh: connect to host box port 22: Operation timed out', 'timeout'],
    ['read ECONNRESET', 'reset'],
    ['kex_exchange_identification: Connection closed by remote host', 'reset'],
    ['SSH relay is not ready', 'relay'],
    ['something entirely unrecognised', 'other']
  ])('classifies %j as %s', (error, expected) => {
    expect(classifySshErrorCategory(error)).toBe(expected)
  })

  describe('auth requires the method suffix, mirroring isAuthError', () => {
    it.each([
      ['Permission denied (publickey).', 'auth'],
      ['Permission denied, please try again.', 'auth'],
      ['All configured authentication methods failed', 'auth'],
      ['Too many authentication failures for alice', 'auth']
    ])('%j is auth', (error, expected) => {
      expect(classifySshErrorCategory(error)).toBe(expected)
    })

    // A bare "permission denied" is a filesystem fault upstream (classified `error`,
    // not `auth-failed`), so sending triage to credentials was wrong.
    it('does not claim a bare permission-denied is an auth failure', () => {
      expect(classifySshErrorCategory('permission denied while checking relay install')).toBe(
        'relay'
      )
      expect(classifySshErrorCategory("EACCES: permission denied, mkdir '/home/u/.orca'")).not.toBe(
        'auth'
      )
    })

    // `publickey,password` is a benign method list on a line whose real cause is elsewhere.
    it('does not treat a continuable-methods list as the cause', () => {
      expect(
        classifySshErrorCategory(
          'debug1: Authentications that can continue: publickey,password\nssh: connect to host box port 22: Connection timed out'
        )
      ).toBe('timeout')
    })
  })

  describe('key-file matches what OpenSSH actually prints', () => {
    it.each([
      ["Permissions 0644 for '/home/u/.ssh/id_rsa' are too open.", 'key-file'],
      ['UNPROTECTED PRIVATE KEY FILE!', 'key-file'],
      ['Load key "/home/u/.ssh/id_rsa": bad permissions', 'key-file']
    ])('%j is key-file', (error, expected) => {
      expect(classifySshErrorCategory(error)).toBe(expected)
    })

    // `no such file` is generic; it used to point relay packaging faults at key material.
    it('does not claim a generic ENOENT is a key-file fault', () => {
      expect(
        classifySshErrorCategory("ENOENT: no such file or directory, open '/tmp/orca-relay.tgz'")
      ).toBe('relay')
    })

    // known_hosts outranks key-file deliberately: the file named IS the diagnosis.
    it('keeps a known_hosts ENOENT in host-key', () => {
      expect(
        classifySshErrorCategory(
          "Could not open user 'known_hosts' file /home/u/.ssh/known_hosts: No such file or directory"
        )
      ).toBe('host-key')
    })
  })

  describe('aggregated multi-line stderr resolves to the terminal cause', () => {
    // ssh-connection.ts splices whole system-ssh stderr into one string, so an
    // earlier warning line used to outrank the failure that ended the connect.
    it('prefers the last classifiable line over table order', () => {
      expect(
        classifySshErrorCategory(
          'System SSH probe failed (exit 255). stderr: Load key "/home/u/.ssh/id_rsa": Permission denied\nssh: connect to host box port 22: Operation timed out'
        )
      ).toBe('timeout')
    })

    it('falls back to earlier lines when the last one classifies nothing', () => {
      expect(
        classifySshErrorCategory('ssh: connect to host box port 22: Connection refused\n\n')
      ).toBe('refused')
    })

    it('still classifies a single-line message', () => {
      expect(classifySshErrorCategory('connect ECONNREFUSED 10.0.0.1:22')).toBe('refused')
    })
  })
})

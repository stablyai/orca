import { describe, expect, it } from 'vitest'
import { findSecureDaclViolation, hardenedDaclSddl } from './windows-secure-dacl'
import { daclFromSddl } from './windows-security-addon.test-fixture'

const USER = 'S-1-5-21-432636774-4279371817-3971399515-1001'
const fileViolation = (sddl: string) => findSecureDaclViolation(daclFromSddl(sddl), USER, false)
const directoryViolation = (sddl: string) => findSecureDaclViolation(daclFromSddl(sddl), USER, true)

describe('findSecureDaclViolation', () => {
  it('accepts what Orca writes, for files and directories', () => {
    expect(fileViolation(hardenedDaclSddl(USER, false))).toBeNull()
    expect(directoryViolation(hardenedDaclSddl(USER, true))).toBeNull()
  })

  // No migration: these are byte-for-byte what the icacls hardening left on this machine.
  it('accepts what the icacls-era hardening left on disk', () => {
    expect(fileViolation(`D:PAI(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;${USER})`)).toBeNull()
    expect(
      directoryViolation(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER})`)
    ).toBeNull()
  })

  it('accepts a protected DACL granting the user alone, and ignores deny rules', () => {
    expect(fileViolation(`D:P(A;;FA;;;${USER})`)).toBeNull()
    expect(fileViolation(`D:P(D;;FA;;;WD)(A;;FA;;;${USER})`)).toBeNull()
    expect(fileViolation(`D:P(A;;0x1f01ff;;;${USER})`)).toBeNull()
    expect(fileViolation(`D:P(A;;GA;;;${USER})`)).toBeNull()
  })

  it.each([
    ['explicit Everyone', `D:P(A;;FA;;;${USER})(A;;FR;;;WD)`, 'S-1-1-0'],
    [
      'inherited Authenticated Users (a relocated root)',
      `D:AI(A;ID;FA;;;${USER})(A;ID;0x1301bf;;;AU)`,
      'S-1-5-11'
    ],
    [
      'inherit-only Users on a directory',
      `D:P(A;OICI;FA;;;${USER})(A;OICIIO;FR;;;BU)`,
      'S-1-5-32-545'
    ]
  ])('rejects %s', (_label, sddl, sid) => {
    expect(directoryViolation(sddl)).toBe(`unexpected rule for ${sid}`)
  })

  // Object, callback and conditional ACEs can grant by rules this check cannot evaluate.
  it.each([
    ['last', `D:P(A;;FA;;;SY)(A;;FA;;;${USER})(XA;;FA;;;WD;(@User.Department == "Finance"))`],
    ['first', `D:P(XA;;FA;;;WD;(@User.Department == "Finance"))(A;;FA;;;SY)(A;;FA;;;${USER})`],
    ['an object ACE', `D:P(A;;FA;;;${USER})(OA;;FR;;;WD)`]
  ])('fails closed on an ACE it cannot evaluate: %s', (_label, sddl) => {
    expect(fileViolation(sddl)).toMatch(/unsupported ACE type/)
  })

  // Loosening the parent reaches anything that still inherits, however tidy it looks today.
  it('requires protection, even when every inherited rule names an allowed principal', () => {
    expect(directoryViolation(`D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;${USER})`)).toMatch(
      /not protected/
    )
    expect(fileViolation(`D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${USER})`)).toMatch(
      /not protected/
    )
  })

  // An inherit-only rule grants the directory itself nothing, so Orca could not write into it.
  it('rejects a path the user cannot actually use', () => {
    const missing = `missing full control for ${USER}`
    expect(directoryViolation(`D:P(A;OICIIO;FA;;;${USER})(A;OICI;FA;;;SY)`)).toBe(missing)
    expect(directoryViolation(`D:P(A;;FA;;;${USER})`)).toBe(missing)
    expect(fileViolation(`D:P(A;;FR;;;${USER})`)).toBe(missing)
  })

  it('fails closed on a NULL DACL, which grants everyone everything', () => {
    expect(findSecureDaclViolation(null, USER, false)).toMatch(/NULL DACL/)
  })

  // The addon hands back raw SIDs, so the built-in Administrator (the CI runner) needs no alias.
  it('checks a RID-500 user by its raw SID', () => {
    const builtinAdmin = 'S-1-5-21-432636774-4279371817-3971399515-500'
    expect(
      findSecureDaclViolation(
        daclFromSddl(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${builtinAdmin})`),
        builtinAdmin,
        true
      )
    ).toBeNull()
    expect(fileViolation(`D:P(A;;FA;;;${builtinAdmin})(A;;FA;;;${USER})`)).toBe(
      `unexpected rule for ${builtinAdmin}`
    )
  })
})

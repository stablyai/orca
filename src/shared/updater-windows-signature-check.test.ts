import { describe, expect, it } from 'vitest'
import {
  isWindowsSignatureCheckUnavailableFailure,
  isWindowsSignatureMismatchFailure
} from './updater-windows-signature-check'

describe('isWindowsSignatureCheckUnavailableFailure', () => {
  it('matches the PowerShell command failure shape (timeout / non-zero exit)', () => {
    expect(
      isWindowsSignatureCheckUnavailableFailure(
        'Command failed: set "PSModulePath=" & chcp 65001 >NUL & powershell.exe -NoProfile ' +
          '-NonInteractive -InputFormat None -Command "Get-AuthenticodeSignature -LiteralPath ' +
          "'C:\\Users\\u\\AppData\\Local\\orca-updater\\pending\\orca-windows-setup.exe' | " +
          'ConvertTo-Json -Compress"'
      )
    ).toBe(true)
  })

  it('matches the stderr failure shape', () => {
    expect(
      isWindowsSignatureCheckUnavailableFailure(
        'Cannot execute Get-AuthenticodeSignature, stderr: Access is denied. ' +
          'Failing signature validation due to unknown stderr.'
      )
    ).toBe(true)
  })

  it('does not match a genuine signature mismatch', () => {
    expect(
      isWindowsSignatureCheckUnavailableFailure(
        'New version 1.4.144 is not signed by the application owner: ' +
          'publisherNames: SignPath Foundation, raw info: {"Status": 0}'
      )
    ).toBe(false)
  })

  it('does not match unrelated update errors', () => {
    expect(isWindowsSignatureCheckUnavailableFailure('net::ERR_HTTP2_PROTOCOL_ERROR')).toBe(false)
    expect(
      isWindowsSignatureCheckUnavailableFailure('Cannot find channel "latest.yml" (404)')
    ).toBe(false)
  })
})

describe('isWindowsSignatureMismatchFailure', () => {
  it('matches the wrong-publisher integrity failure', () => {
    expect(
      isWindowsSignatureMismatchFailure(
        'New version 1.4.144 is not signed by the application owner: ' +
          'publisherNames: SignPath Foundation, raw info: {"Status": 0}'
      )
    ).toBe(true)
  })

  it('is mutually exclusive with the check-unavailable classifier', () => {
    const mismatch = 'New version 1.4.144 is not signed by the application owner: publisherNames: X'
    expect(isWindowsSignatureMismatchFailure(mismatch)).toBe(true)
    expect(isWindowsSignatureCheckUnavailableFailure(mismatch)).toBe(false)

    const blocked = 'Command failed: … Get-AuthenticodeSignature -LiteralPath …'
    expect(isWindowsSignatureCheckUnavailableFailure(blocked)).toBe(true)
    expect(isWindowsSignatureMismatchFailure(blocked)).toBe(false)
  })

  it('does not match unrelated errors', () => {
    expect(isWindowsSignatureMismatchFailure('net::ERR_HTTP2_PROTOCOL_ERROR')).toBe(false)
  })
})

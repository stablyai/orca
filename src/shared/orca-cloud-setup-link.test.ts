import { describe, expect, it } from 'vitest'
import {
  findOrcaCloudSetupReturnLink,
  parseOrcaCloudSetupReturnLink
} from './orca-cloud-setup-link'

const ID = 'cs_AbCdEfGhIjKlMnOpQrSt_-'

describe('parseOrcaCloudSetupReturnLink', () => {
  it('accepts the done page link with a well-formed session id', () => {
    expect(parseOrcaCloudSetupReturnLink(`orca://cloud/setup/return?session=${ID}`)).toEqual({
      sessionId: ID
    })
    expect(parseOrcaCloudSetupReturnLink(`orca://cloud/setup/return/?session=${ID}`)).toEqual({
      sessionId: ID
    })
  })

  it('rejects other hosts, paths, schemes and malformed ids', () => {
    for (const raw of [
      'orca://cloud/setup/return',
      'orca://cloud/setup/return?session=',
      'orca://cloud/setup/return?session=cs_short',
      `orca://cloud/setup/return?session=${ID}x`,
      'orca://cloud/setup/return?session=cs_AbCdEfGhIjKlMnOpQr%2F_-',
      `orca://cloud/setup/other?session=${ID}`,
      `orca://billing/setup/return?session=${ID}`,
      `orca://cloud/w/setup/return?session=${ID}`,
      `https://cloud/setup/return?session=${ID}`,
      'not a url'
    ]) {
      expect(parseOrcaCloudSetupReturnLink(raw)).toBeNull()
    }
  })

  it('finds the link among launch arguments', () => {
    expect(
      findOrcaCloudSetupReturnLink(['--flag', `orca://cloud/setup/return?session=${ID}`])
    ).toEqual({ sessionId: ID })
    expect(findOrcaCloudSetupReturnLink(['--flag'])).toBeNull()
  })
})

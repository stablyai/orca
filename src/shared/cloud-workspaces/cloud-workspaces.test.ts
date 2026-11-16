import { describe, expect, it } from 'vitest'
import {
  CloudWorkspaceSchema,
  formatWorkspaceNumber,
  parseCloudWorkspaceLink
} from './cloud-workspaces-wire'
import { base64ToBytes, bytesToBase64 } from './sealed-grant'
import { stripSenderEnvelopes } from './sender-envelope'

const ID = 'sbx_0123456789abcdef01234567'

describe('cloud workspace links', () => {
  it('parses workspace and chat links', () => {
    expect(parseCloudWorkspaceLink(`orca://cloud/w/${ID}`)).toEqual({
      target: { kind: 'id', workspaceId: ID },
      chatId: null
    })
    expect(parseCloudWorkspaceLink(`orca://cloud/w/${ID}/c/chat%201%2F2`)).toEqual({
      target: { kind: 'id', workspaceId: ID },
      chatId: 'chat 1/2'
    })
  })

  it('parses org slug and number links', () => {
    expect(parseCloudWorkspaceLink('orca://cloud/acme-labs/W-123')).toEqual({
      target: { kind: 'number', org: 'acme-labs', number: 123 },
      chatId: null
    })
    expect(parseCloudWorkspaceLink('orca://cloud/acme/w-7/c/s%3Aabc/')).toEqual({
      target: { kind: 'number', org: 'acme', number: 7 },
      chatId: 's:abc'
    })
  })

  it('rejects anything that is not a cloud workspace link', () => {
    for (const bad of [
      'orca://cloud/w/sbx_nothex',
      `https://cloud/w/${ID}`,
      `orca://cloud/w/${ID}/x`,
      `orca://cloud/w/${ID}/c/%E0%A4%A`,
      'orca://cloud/setup/return?session=cs_1',
      'orca://cloud/Acme/W-1',
      'orca://cloud/a--b/W-1',
      'orca://cloud/acme/W-0',
      'orca://cloud/acme/W-x'
    ]) {
      expect(parseCloudWorkspaceLink(bad)).toBeNull()
    }
  })

  it('formats workspace numbers', () => {
    expect(formatWorkspaceNumber(42)).toBe('W-42')
  })
})

describe('sealed grant base64', () => {
  it('matches the platform encoder for every length', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff)
      const b64 = Buffer.from(bytes).toString('base64')
      expect(bytesToBase64(bytes)).toBe(b64)
      expect([...base64ToBytes(b64)]).toEqual([...bytes])
    }
  })
})

describe('sender lines in older transcripts', () => {
  it('strips the line, every stacked one and legacy ones with an email', () => {
    expect(stripSenderEnvelopes('[orca-sender name="Bob \\"B\\" Lee" id="user_bob"]\nfix it')).toBe(
      'fix it'
    )
    expect(
      stripSenderEnvelopes(
        '[orca-sender name="A" id="a"]\n[orca-sender name="B" id="b" email="b@x.dev"]\nhello'
      )
    ).toBe('hello')
  })

  it('leaves anything else alone', () => {
    expect(stripSenderEnvelopes('plain')).toBe('plain')
    expect(stripSenderEnvelopes('[orca-sender name="x" id="bad id"]\nhi')).toBe(
      '[orca-sender name="x" id="bad id"]\nhi'
    )
    expect(stripSenderEnvelopes('hi\n[orca-sender name="A" id="a"]\n')).toBe(
      'hi\n[orca-sender name="A" id="a"]\n'
    )
  })
})

describe('workspace member names', () => {
  const base = {
    id: 'sbx_1',
    workspaceId: 'ws-1',
    status: 'running',
    machineSize: 'standard',
    region: 'iad1',
    createdAt: 1,
    title: null,
    repo: null,
    section: null,
    archivedAt: null,
    createdBy: 'alice',
    ownerUserId: 'alice',
    lastActivityAt: 1,
    lastActivityBy: null,
    cost: {
      computeMs: 0,
      rateUsdMicrosPerHour: 0,
      computeUsdMicros: 0,
      tokenUsdMicros: null,
      totalUsdMicros: 0
    },
    access: 'owner'
  }

  it('keeps names from the name claim and tolerates older or malformed control planes', () => {
    expect(
      CloudWorkspaceSchema.parse({ ...base, memberNames: { alice: 'Alice' } }).memberNames
    ).toEqual({
      alice: 'Alice'
    })
    expect(CloudWorkspaceSchema.parse(base).memberNames).toBeUndefined()
    expect(
      CloudWorkspaceSchema.parse({ ...base, memberNames: { alice: 'x'.repeat(81) } }).memberNames
    ).toBeUndefined()
  })

  it('still parses rows that carry the retired sharing fields', () => {
    const parsed = CloudWorkspaceSchema.parse({
      ...base,
      visibility: 'team',
      presence: [{ userId: 'bob', state: 'typing' }],
      followers: ['bob'],
      following: true,
      link: 'orca://cloud/acme/W-1'
    })
    expect(parsed.id).toBe('sbx_1')
    expect(parsed.visibility).toBe('team')
    expect('presence' in parsed || 'followers' in parsed || 'link' in parsed).toBe(false)
    expect(CloudWorkspaceSchema.parse(base).visibility).toBeUndefined()
    expect(CloudWorkspaceSchema.parse({ ...base, visibility: 'org' }).visibility).toBeUndefined()
  })
})

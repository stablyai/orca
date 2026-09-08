import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_FILE_EDIT_MAX_BYTES,
  MobileWebFileWritePayloadSchema
} from './file-edit-contract'

const IDENTITY = {
  workspaceId: 'repo-1::/workspace',
  relativePath: 'src/index.ts',
  expectedRevision: 'a'.repeat(64)
}

describe('mobile web file edit contract', () => {
  it('accepts bounded base64 file content including an empty file', () => {
    expect(MobileWebFileWritePayloadSchema.parse({ ...IDENTITY, contentBase64: '' })).toMatchObject(
      IDENTITY
    )
    expect(
      MobileWebFileWritePayloadSchema.parse({
        ...IDENTITY,
        contentBase64: Buffer.alloc(MOBILE_WEB_FILE_EDIT_MAX_BYTES).toString('base64')
      })
    ).toMatchObject(IDENTITY)
  })

  it('rejects malformed, oversized, or unsafe file identities', () => {
    for (const input of [
      { ...IDENTITY, contentBase64: '!!!!' },
      {
        ...IDENTITY,
        contentBase64: Buffer.alloc(MOBILE_WEB_FILE_EDIT_MAX_BYTES + 1).toString('base64')
      },
      { ...IDENTITY, relativePath: '../secret', contentBase64: '' },
      { ...IDENTITY, expectedRevision: 'short', contentBase64: '' }
    ]) {
      expect(MobileWebFileWritePayloadSchema.safeParse(input).success).toBe(false)
    }
  })
})

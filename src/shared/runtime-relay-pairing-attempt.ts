import { hardenExistingSecureFile } from './secure-file'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeSecureJsonFileWithinLimit } from './bounded-secure-json-file'
import { readNodeFileSyncWithinLimit } from './node-bounded-file-reader'
import type { PairingOffer } from './pairing'

const AttemptSchema = z
  .object({
    reqId: z.string().uuid(),
    resumeToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
  })
  .strict()

export function runtimeRelayPairingAttempt(userDataPath: string, offer: PairingOffer) {
  const identity = createHash('sha256')
    .update(JSON.stringify([offer.publicKeyB64, offer.deviceToken]))
    .digest('hex')
  const path = join(userDataPath, `runtime-relay-pairing-${identity}.json`)
  const recovered = existsSync(path)
  if (recovered) {
    hardenExistingSecureFile(path)
  }
  const attempt = recovered
    ? AttemptSchema.parse(
        JSON.parse(readNodeFileSyncWithinLimit(path, 4096).buffer.toString('utf8'))
      )
    : { reqId: randomUUID(), resumeToken: randomBytes(32).toString('base64url') }
  if (!recovered) {
    writeSecureJsonFileWithinLimit(path, attempt, 4096, { durable: true })
  }
  return {
    ...attempt,
    recovered,
    tokenHash: createHash('sha256').update(attempt.resumeToken).digest('base64url'),
    finish: () => rmSync(path, { force: true })
  }
}

import nacl from 'tweetnacl'
import { decodeBase64Bytes } from '@/lib/base64-bytes'
import type { PairedE2EEPrimitives } from '../../../shared/paired-e2ee-primitives'
import { derivePairedE2EEV2KeySchedule } from '../../../shared/paired-e2ee-v2-key-schedule'
import {
  decrypt,
  decryptBytes,
  deriveSharedKey,
  encrypt,
  encryptBytes,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from './web-e2ee'

export const WEB_PAIRED_E2EE_PRIMITIVES: PairedE2EEPrimitives = {
  generateKeyPair,
  deriveSharedKey,
  randomBytes: (length) => nacl.randomBytes(length),
  encodeBase64: publicKeyToBase64,
  decodeBase64: decodeBase64Bytes,
  publicKeyFromBase64,
  publicKeyToBase64,
  sealLegacyText: encrypt,
  openLegacyText: decrypt,
  sealLegacyBinary: encryptBytes,
  openLegacyBinary: decryptBytes,
  deriveV2KeySchedule: derivePairedE2EEV2KeySchedule
}

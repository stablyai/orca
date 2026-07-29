import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import path from 'node:path'

async function sha256(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

export async function proveDistinctInstallerPair({ fromPath, toPath, fromVersion, toVersion }) {
  const [fromHash, toHash] = await Promise.all([sha256(fromPath), sha256(toPath)])
  const proof = {
    from: { path: path.resolve(fromPath), version: fromVersion, sha256: fromHash },
    to: { path: path.resolve(toPath), version: toVersion, sha256: toHash }
  }
  const errors = []
  if (proof.from.path.toLowerCase() === proof.to.path.toLowerCase()) {
    errors.push('base and candidate installer paths are identical')
  }
  if (fromHash === toHash) {
    errors.push('base and candidate installer SHA-256 hashes are identical')
  }
  if (!fromVersion || !toVersion) {
    errors.push('both installer versions must be readable')
  } else if (fromVersion === toVersion) {
    errors.push(`base and candidate installer versions are identical (${fromVersion})`)
  }
  if (errors.length > 0) {
    throw new Error(`Distinct installer proof failed: ${errors.join('; ')}`)
  }
  return proof
}

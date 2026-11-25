import { URI } from 'monaco-editor/esm/vs/base/common/uri.js'

const FILE_SCHEME = /^file:/i
// Monaco keeps closed-file undo for this scheme, and its default labels show the URI path.
const OWNED_SCHEME = 'vscode-remote'
const OWNED_SCHEME_PREFIX = /^vscode-remote:/i
const UNC_AUTHORITY_SUFFIX = '-unc'

/** Two FNV-1a lanes produce a compact, stable owner authority. */
function ownerAuthority(ownerKey: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let index = 0; index < ownerKey.length; index += 1) {
    const code = ownerKey.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x811c9dc5) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

/** Use one round-trippable key for creation, lookup and ownership. Uri.file preserves Windows file schemes and closed-file undo; Uri.parse would treat drive letters as schemes. */
export function toEditorModelUri(filePath: string, ownerKey = ''): string {
  if (OWNED_SCHEME_PREFIX.test(filePath)) {
    // Preserve the existing owned key’s authority and real host path.
    const owned = URI.parse(filePath)
    if (!ownerKey) {
      return owned.toString()
    }
    const unc = owned.authority.endsWith(UNC_AUTHORITY_SUFFIX)
    return ownedModelUri(ownerKey, owned.path, unc)
  }
  const parsed = FILE_SCHEME.test(filePath) ? URI.parse(filePath) : URI.file(filePath)
  const local = URI.file(parsed.fsPath)
  if (!ownerKey) {
    return local.with({ fragment: parsed.fragment }).toString()
  }
  // Owner authorities form TypeScript import roots: .. cannot reach other hosts or local models, and real extensions remain last for TSX detection. Reparse to apply drive-letter folding.
  const folded = URI.parse(local.toString())
  return folded.authority
    ? ownedModelUri(ownerKey, `/${folded.authority}${folded.path}`, true)
    : ownedModelUri(ownerKey, folded.path, false)
}

function ownedModelUri(ownerKey: string, path: string, unc: boolean): string {
  // Tag UNC identity in the authority; worker path normalization collapses //server and would conflate it with a local /server path.
  const authority = ownerAuthority(ownerKey) + (unc ? UNC_AUTHORITY_SUFFIX : '')
  return URI.from({ scheme: OWNED_SCHEME, authority, path }).toString()
}

import { WINDOWS_FILE_ALL_ACCESS, type WindowsDacl } from './windows-security-addon'

/** SYSTEM and the local Administrators group: they can take ownership regardless, so denying them buys nothing. */
export const LOCAL_SYSTEM_SID = 'S-1-5-18'
export const BUILTIN_ADMINISTRATORS_SID = 'S-1-5-32-544'

export const ACCESS_ALLOWED_ACE_TYPE = 0
export const ACCESS_DENIED_ACE_TYPE = 1
export const OBJECT_INHERIT_ACE = 0x1
export const CONTAINER_INHERIT_ACE = 0x2
export const INHERIT_ONLY_ACE = 0x8
const GENERIC_ALL = 0x10000000

/** Install protected user/SYSTEM/Administrators full control; directory rules inherit so newly created children start restricted. */
export function hardenedDaclSddl(userSid: string, isDirectory: boolean): string {
  const flags = isDirectory ? 'OICI' : ''
  return `D:P(A;${flags};FA;;;${LOCAL_SYSTEM_SID})(A;${flags};FA;;;${BUILTIN_ADMINISTRATORS_SID})(A;${flags};FA;;;${userSid})`
}

/** Allow only user/SYSTEM/Administrators, require parent-inheritance protection and usable user access.
 * Accept equivalent private legacy DACLs instead of rewriting them to exactly match the current recipe. */
export function findSecureDaclViolation(
  dacl: WindowsDacl | null,
  userSid: string,
  isDirectory: boolean
): string | null {
  if (!dacl) {
    return 'the path has a NULL DACL, which grants everyone everything'
  }
  // Object, callback and conditional ACEs can grant by rules this check cannot evaluate.
  const unsupported = dacl.aces.find(
    (ace) => ace.type !== ACCESS_ALLOWED_ACE_TYPE && ace.type !== ACCESS_DENIED_ACE_TYPE
  )
  if (unsupported) {
    return `unsupported ACE type ${unsupported.type}`
  }
  const allowed = new Set([userSid, LOCAL_SYSTEM_SID, BUILTIN_ADMINISTRATORS_SID])
  const stranger = dacl.aces.find(
    (ace) => ace.type === ACCESS_ALLOWED_ACE_TYPE && !allowed.has(ace.sid ?? '')
  )
  if (stranger) {
    return `unexpected rule for ${stranger.sid}`
  }
  if (!dacl.protected) {
    return 'DACL is not protected; the parent still propagates into it'
  }
  const inheritsToChildren = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
  // An inherit-only rule grants the directory itself nothing, so Orca could not write into it.
  const usable = dacl.aces.some(
    (ace) =>
      ace.type === ACCESS_ALLOWED_ACE_TYPE &&
      ace.sid === userSid &&
      (ace.flags & INHERIT_ONLY_ACE) === 0 &&
      ((ace.mask & GENERIC_ALL) !== 0 ||
        (ace.mask & WINDOWS_FILE_ALL_ACCESS) === WINDOWS_FILE_ALL_ACCESS) &&
      (!isDirectory || (ace.flags & inheritsToChildren) === inheritsToChildren)
  )
  return usable ? null : `missing full control for ${userSid}`
}

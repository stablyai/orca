export type BranchSwitchTarget = { kind: 'local' | 'remote' | 'new'; name: string }
export type BranchSwitchCreation = { kind: 'new' } | { kind: 'remote'; startPoint: string }

export function isBranchNameValid(name: string): boolean {
  return (
    name.length > 0 &&
    name !== '@' &&
    !name.startsWith('-') &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.endsWith('.') &&
    !/[\s~^:?*[\\]/.test(name) &&
    !Array.from(name).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) &&
    !name.includes('..') &&
    !name.includes('@{') &&
    !name.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))
  )
}

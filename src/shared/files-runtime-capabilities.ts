import {
  FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY,
  FILE_WRITE_IDENTICAL_RUNTIME_CAPABILITY
} from './file-write-disk-precondition'

// Why: older runtimes strip mutation owner fields, so clients must fence writes before RPC.
export const FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY = 'files.mutation-ownership.v1' as const
export const FILE_MUTATION_OWNERSHIP_UPDATE_REQUIRED_MESSAGE =
  'Remote file changes require a newer Orca server. Update the HUB and try again.'

export const FILE_DOC_PREVIEW_RUNTIME_CAPABILITY = 'files.readDocPreview' as const

export const FILES_RUNTIME_CAPABILITIES = [
  'files.pathsExist',
  'files.resolve-terminal-path.cross-workspace.v1',
  FILE_DOC_PREVIEW_RUNTIME_CAPABILITY,
  FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY,
  FILE_WRITE_IDENTICAL_RUNTIME_CAPABILITY,
  FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY
] as const

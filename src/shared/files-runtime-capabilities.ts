import {
  FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY,
  FILE_WRITE_IDENTICAL_RUNTIME_CAPABILITY
} from './file-write-disk-precondition'
import { STAGED_FILE_SAVE_RUNTIME_CAPABILITY } from './staged-file-save'
import { FILE_REPLACE_WITH_UPLOAD_RUNTIME_CAPABILITY } from './file-bytes-write'

// Why: older runtimes strip mutation owner fields, so clients must fence writes before RPC.
export const FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY = 'files.mutation-ownership.v1' as const
export const FILE_MUTATION_OWNERSHIP_UPDATE_REQUIRED_MESSAGE =
  'Remote file changes require a newer Orca server. Update the HUB and try again.'

// Why: older hosts drop `offset`/`limit` and answer with the whole folder.
export const FILE_READ_DIR_PAGED_RUNTIME_CAPABILITY = 'files.readDir.paged.v1' as const

export const FILE_DOC_PREVIEW_RUNTIME_CAPABILITY = 'files.readDocPreview' as const

export const FILES_RUNTIME_CAPABILITIES = [
  'files.pathsExist',
  'files.resolve-terminal-path.cross-workspace.v1',
  'files.resolve-terminal-path.absolute-files.v1',
  FILE_DOC_PREVIEW_RUNTIME_CAPABILITY,
  FILE_READ_DIR_PAGED_RUNTIME_CAPABILITY,
  FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY,
  FILE_WRITE_IDENTICAL_RUNTIME_CAPABILITY,
  FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
  STAGED_FILE_SAVE_RUNTIME_CAPABILITY,
  FILE_REPLACE_WITH_UPLOAD_RUNTIME_CAPABILITY
] as const

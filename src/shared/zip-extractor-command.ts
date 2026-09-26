import { join } from 'node:path'

/** The destination must already exist; callers extract only checksum-verified archives. */
export function getZipExtractorCommand(
  zipPath: string,
  extractDir: string
): { file: string; args: string[]; label: string } {
  if (process.platform === 'win32' && !process.env.ORCA_UNZIP_BIN) {
    return {
      file: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'),
      args: ['-xf', zipPath, '-C', extractDir],
      label: 'tar'
    }
  }
  return {
    file: process.env.ORCA_UNZIP_BIN || 'unzip',
    args: ['-q', zipPath, '-d', extractDir],
    label: 'unzip'
  }
}

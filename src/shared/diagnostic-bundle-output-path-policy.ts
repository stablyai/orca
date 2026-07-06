export const DIAGNOSTIC_OUTPUT_PATH_ERROR = 'diagnostic_output_path_outside_diagnostics_directory'

export function isSafeDiagnosticBundleOutputPath(output: string): boolean {
  return parseSafeDiagnosticBundleOutputPath(output) !== null
}

export function parseSafeDiagnosticBundleOutputPath(output: string): string[] | null {
  const normalized = output.trim().replace(/\\/g, '/')
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.startsWith('//') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.includes('\0')
  ) {
    return null
  }
  const segments = normalized.split('/').filter((segment) => segment && segment !== '.')
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === '..' || segment.includes(':'))
  ) {
    return null
  }
  return segments
}

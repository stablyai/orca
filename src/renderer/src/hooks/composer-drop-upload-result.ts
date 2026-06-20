export type ComposerDropUploadImportResult =
  | {
      status: 'imported'
      destPath: string
      kind: 'file' | 'directory'
    }
  | {
      status: 'skipped' | 'failed'
    }

export type ComposerDropUploadResult = {
  filePaths: string[]
  folderPaths: string[]
  skippedOrFailed: number
}

export function collectComposerDropUploadResult(
  results: readonly ComposerDropUploadImportResult[]
): ComposerDropUploadResult {
  const filePaths: string[] = []
  const folderPaths: string[] = []
  let skippedOrFailed = 0

  for (const result of results) {
    if (result.status !== 'imported') {
      skippedOrFailed += 1
      continue
    }
    if (result.kind === 'directory') {
      folderPaths.push(result.destPath)
    } else {
      filePaths.push(result.destPath)
    }
  }

  return { filePaths, folderPaths, skippedOrFailed }
}

export function shouldReportComposerDropUploadFailure(
  uploadResult: Pick<ComposerDropUploadResult, 'skippedOrFailed'>,
  canReport: () => boolean
): boolean {
  return uploadResult.skippedOrFailed > 0 && canReport()
}

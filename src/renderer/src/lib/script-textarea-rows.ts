export const SCRIPT_TEXTAREA_ROW_SCAN_CODE_UNITS = 64 * 1024

export function getDetectedSetupScriptTextareaRows(setup: string): number {
  return clampRows(countScriptTextareaLines(setup, 6), 2, 6)
}

export function getRepositoryHookScriptTextareaRows(script: string): number {
  const lineCount = script.length === 0 ? 0 : countScriptTextareaLines(script, 13)
  return clampRows(lineCount + 1, 4, 14)
}

// Uncapped, unlike the textarea row scan; a trailing newline adds no visible line.
export function countScriptLines(text: string): number {
  const end = text.endsWith('\n') ? text.length - 1 : text.length
  let lines = 1
  for (
    let index = text.indexOf('\n');
    index !== -1 && index < end;
    index = text.indexOf('\n', index + 1)
  ) {
    lines += 1
  }
  return lines
}

function countScriptTextareaLines(text: string, maxLines: number): number {
  if (text.length === 0) {
    return 1
  }

  const scanLength = Math.min(text.length, SCRIPT_TEXTAREA_ROW_SCAN_CODE_UNITS)
  let lines = 1
  for (let index = 0; index < scanLength; index += 1) {
    if (text.charCodeAt(index) !== 10) {
      continue
    }
    lines += 1
    if (lines >= maxLines) {
      return lines
    }
  }
  return lines
}

function clampRows(value: number, minRows: number, maxRows: number): number {
  return Math.min(Math.max(value, minRows), maxRows)
}

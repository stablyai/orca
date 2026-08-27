export type SettingsFrame = {
  FramePid: number
  AppPid: number
  FrameHwnd: string
}

export type SettingsCloseStatus = 'Closed' | 'AlreadyGone' | 'IdentityMismatch'

export type SettingsCloseResult = {
  Status: SettingsCloseStatus
}

const CLOSE_STATUSES = ['Closed', 'AlreadyGone', 'IdentityMismatch'] as const

export function parseSettingsLaunchOutput(stdout: string): SettingsFrame {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch (parseError) {
    throw new Error(
      `Failed to parse SettingsFrameLauncher output as JSON.\nStdout: ${stdout}\nError: ${parseError instanceof Error ? parseError.message : String(parseError)}`
    )
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Number.isSafeInteger((parsed as Record<string, unknown>).FramePid) ||
    ((parsed as Record<string, unknown>).FramePid as number) <= 0 ||
    !Number.isSafeInteger((parsed as Record<string, unknown>).AppPid) ||
    ((parsed as Record<string, unknown>).AppPid as number) <= 0 ||
    typeof (parsed as Record<string, unknown>).FrameHwnd !== 'string' ||
    !/^0x[0-9a-f]+$/i.test((parsed as Record<string, unknown>).FrameHwnd as string) ||
    BigInt((parsed as Record<string, unknown>).FrameHwnd as string) === BigInt(0)
  ) {
    throw new Error(`Invalid SettingsFrameLauncher payload shape: ${stdout}`)
  }

  return parsed as SettingsFrame
}

export function parseSettingsCloseOutput(stdout: string): SettingsCloseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    throw new Error(`Failed to parse SettingsFrameLauncher close output as JSON: ${stdout}`)
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).Status !== 'string' ||
    !CLOSE_STATUSES.includes((parsed as Record<string, unknown>).Status as SettingsCloseStatus)
  ) {
    throw new Error(`Invalid SettingsFrameLauncher close payload: ${stdout}`)
  }

  return parsed as SettingsCloseResult
}

export function buildGetSettingsStateArgs(frame: SettingsFrame): string[] {
  return [
    'computer',
    'get-app-state',
    '--app',
    `pid:${frame.FramePid}`,
    '--window-id',
    BigInt(frame.FrameHwnd).toString(10),
    '--no-screenshot',
    '--json'
  ]
}

export function buildCloseSettingsArgs(frame: SettingsFrame): string[] {
  return [
    '-Action',
    'Close',
    '-Hwnd',
    frame.FrameHwnd,
    '-FramePid',
    String(frame.FramePid),
    '-AppPid',
    String(frame.AppPid),
    '-TimeoutMilliseconds',
    '5000'
  ]
}

// Secondary-action metadata is Orca-generated (English on any OS locale), so
// targeting survives localized roles/names; raw ControlType.* lines are window chrome.
export function findSettingsSearchBoxCandidates(treeText: string): string[] {
  return treeText
    .split('\n')
    .filter((line) => !/ControlType\./.test(line) && line.endsWith('Secondary Actions: SetValue'))
}

// Returns the search box line iff exactly one candidate exists; null otherwise,
// so callers can choose strict failure or transient retry.
export function selectSettingsSearchBoxLine(treeText: string): string | null {
  const candidates = findSettingsSearchBoxCandidates(treeText)
  return candidates.length === 1 ? (candidates.at(0) ?? null) : null
}

// Locale-free targeting: fail loudly when the Settings home layout drifts.
export function requireUniqueSettingsSearchBoxIndex(treeText: string): number {
  const line = selectSettingsSearchBoxLine(treeText)
  if (line === null) {
    const candidates = findSettingsSearchBoxCandidates(treeText)
    throw new Error(
      `Expected exactly one Settings search box candidate (Secondary Actions: SetValue, non-chrome), got ${candidates.length}:\n${candidates.join('\n')}`
    )
  }
  return parseElementLineIndex(line)
}

// The result echo must come from a different indexed element, never a header/summary line.
export function findSettingsSearchEchoLines(
  treeText: string,
  probe: string,
  fieldIndex: number
): string[] {
  return treeText
    .split('\n')
    .filter(
      (line) =>
        /^\s*\d+\s/.test(line) && line.includes(probe) && parseElementLineIndex(line) !== fieldIndex
    )
}

export function parseElementLineIndex(line: string): number {
  const index = Number.parseInt(line.match(/^\s*(\d+)/)?.[1] ?? '', 10)
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Not an indexed element line: ${JSON.stringify(line)}`)
  }
  return index
}

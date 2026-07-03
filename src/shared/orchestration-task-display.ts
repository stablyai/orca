export const ORCHESTRATION_TASK_TITLE_MAX_LENGTH = 80
export const ORCHESTRATION_DISPLAY_NAME_MAX_LENGTH = 160

export type OrchestrationTaskDisplayMetadata = {
  taskTitle: string
  displayName: string
}

export function buildOrchestrationTaskDisplayMetadata(input: {
  spec: string
  taskTitle?: string | null
  displayName?: string | null
}): OrchestrationTaskDisplayMetadata {
  const taskTitle =
    normalizeSingleLine(input.taskTitle, ORCHESTRATION_TASK_TITLE_MAX_LENGTH) ||
    deriveTaskTitleFromSpec(input.spec)
  const displayName =
    normalizeSingleLine(input.displayName, ORCHESTRATION_DISPLAY_NAME_MAX_LENGTH) || taskTitle
  return { taskTitle, displayName }
}

function deriveTaskTitleFromSpec(spec: string): string {
  for (const line of spec.split(/\r?\n/)) {
    const title = normalizeSingleLine(line, ORCHESTRATION_TASK_TITLE_MAX_LENGTH)
    if (title) {
      return title
    }
  }
  return normalizeSingleLine(spec, ORCHESTRATION_TASK_TITLE_MAX_LENGTH)
}

function normalizeSingleLine(value: string | null | undefined, maxLength: number): string {
  if (!value) {
    return ''
  }
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized) {
    return ''
  }
  if (normalized.length <= maxLength) {
    return normalized
  }
  const body = trimDanglingHighSurrogate(normalized.slice(0, maxLength - 3)).trimEnd()
  return `${body}...`
}

function trimDanglingHighSurrogate(value: string): string {
  if (value.length === 0) {
    return value
  }
  const lastCode = value.charCodeAt(value.length - 1)
  return lastCode >= 0xd800 && lastCode <= 0xdbff ? value.slice(0, -1) : value
}

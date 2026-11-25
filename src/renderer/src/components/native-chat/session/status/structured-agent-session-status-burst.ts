import { structuralValuesEqualIgnoringUndefined } from '../../../../../../shared/collections/structural-value-equality'
import {
  sameSemanticTab,
  type Member,
  type ProjectionInput
} from './structured-agent-session-status-membership'

const STREAMING_BURST_WINDOW_MS = 33

function streamingOnly(previous: ProjectionInput | undefined, next: ProjectionInput): boolean {
  if (
    !previous ||
    previous.summary?.status !== 'working' ||
    next.summary?.status !== 'working' ||
    !sameSemanticTab(previous.tab, next.tab) ||
    previous.observation !== next.observation ||
    previous.failedAt !== next.failedAt ||
    previous.sleptAt !== next.sleptAt ||
    previous.directory !== next.directory
  ) {
    return false
  }
  const {
    lastAssistantMessage: _previousText,
    updatedAt: _previousTime,
    ...before
  } = previous.summary
  const { lastAssistantMessage: _nextText, updatedAt: _nextTime, ...after } = next.summary
  return structuralValuesEqualIgnoringUndefined(before, after)
}

/** Retain only the latest prose tick per member; publish every semantic transition synchronously. */
export function createStructuredSessionStatusBurst(
  publish: (inputs: ProjectionInput[]) => void,
  enqueue: (operation: () => void) => void
) {
  const pending = new Map<Member, ProjectionInput>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastPublishedAt = 0
  let disposed = false
  const cancelTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  const apply = (inputs: ProjectionInput[]): void => {
    lastPublishedAt = Date.now()
    publish(inputs)
  }
  const flush = (): void => {
    cancelTimer()
    const inputs = [...pending.values()]
    pending.clear()
    if (!disposed && inputs.length) {
      apply(inputs)
    }
  }
  return {
    flush,
    peek: (member: Member): ProjectionInput | undefined => pending.get(member),
    add: (inputs: ProjectionInput[]): void => {
      if (disposed) {
        return
      }
      if (!inputs.length) {
        publish(inputs)
        return
      }
      if (inputs.some((input) => !streamingOnly(input.member.captured, input))) {
        flush()
        apply(inputs)
        return
      }
      if (timer === null && Date.now() - lastPublishedAt >= STREAMING_BURST_WINDOW_MS) {
        apply(inputs)
        return
      }
      for (const input of inputs) {
        pending.set(input.member, input)
      }
      timer ??= setTimeout(() => enqueue(flush), STREAMING_BURST_WINDOW_MS)
    },
    forget: (member: Member): void => {
      pending.delete(member)
      if (!pending.size) {
        cancelTimer()
      }
    },
    dispose: (): void => {
      disposed = true
      cancelTimer()
      pending.clear()
    }
  }
}

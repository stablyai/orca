import type { RoomAgentActivity, RoomEvent, RoomParticipant } from '../../../../shared/rooms'
import {
  isStructuredMachineAgent,
  type StructuredMachineAgent
} from '../../../../shared/structured-agent-provider'
import {
  BUFFERED_FINAL_CHARS_PER_SECOND,
  StreamingTextFrameQueue
} from '../native-chat/streaming-text-frame-queue'
import {
  activityWithEmptyText,
  activityWithoutFinalText,
  activityWithVisibleRoomText,
  appendActivityDeltas,
  frameTarget,
  projectActivityText
} from './room-activity-text-projection'

type ActivityStream = {
  canonical: RoomAgentActivity
  visual: RoomAgentActivity
  queue: StreamingTextFrameQueue
  streamFinal: boolean
  finalCharsPerSecond?: number
}

export class RoomActivityFrameProjector {
  private readonly machineParticipants = new Map<string, StructuredMachineAgent>()
  private readonly streams = new Map<string, ActivityStream>()
  private readonly draining = new Set<string>()
  private readonly deferred = new Map<string, RoomEvent[]>()

  constructor(
    private readonly emit: (event: RoomEvent) => void,
    private readonly shouldStream: (agent: StructuredMachineAgent) => boolean = () => true
  ) {}

  push(event: RoomEvent): void {
    if (event.type === 'snapshot') {
      this.reset()
      this.updateMachineParticipants(event.snapshot.participants)
      const activities = event.snapshot.activities.map((activity) => {
        const visible = activityWithVisibleRoomText(activity)
        const agent = this.machineParticipants.get(activity.participantId)
        if (agent) {
          const stream = this.createStream(visible, visible, agent)
          this.streams.set(activity.participantId, stream)
          return stream.streamFinal ? visible : activityWithoutFinalText(visible)
        }
        return visible
      })
      this.emit({ ...event, snapshot: { ...event.snapshot, activities } })
      return
    }
    if (event.type === 'end') {
      this.reset()
      this.emit(event)
      return
    }
    const participantId = eventParticipantId(event)
    if (participantId && this.draining.has(participantId)) {
      const events = this.deferred.get(participantId) ?? []
      events.push(event)
      this.deferred.set(participantId, events)
      return
    }
    if (event.type === 'participant.updated') {
      this.updateMachineParticipant(event.participant)
      this.emit(event)
      return
    }
    if (event.type === 'participant.removed') {
      this.disposeStream(event.participantId)
      this.machineParticipants.delete(event.participantId)
      this.emit(event)
      return
    }
    if (event.type === 'activity.updated') {
      this.updateActivity(event.activity)
      return
    }
    if (event.type === 'message.created' && event.message.actorKind === 'agent') {
      if (event.message.senderId && this.deferUntilDrained(event.message.senderId, event)) {
        return
      }
    } else if (event.type === 'activity.cleared') {
      if (this.deferUntilDrained(event.participantId, event)) {
        return
      }
      this.disposeStream(event.participantId)
    }
    this.emit(event)
  }

  dispose(): void {
    this.reset()
    this.machineParticipants.clear()
  }

  private updateActivity(activity: RoomAgentActivity): void {
    activity = activityWithVisibleRoomText(activity)
    if (!this.machineParticipants.has(activity.participantId)) {
      this.disposeStream(activity.participantId)
      this.emit({ type: 'activity.updated', activity })
      return
    }
    const current = this.streams.get(activity.participantId)
    if (!current || current.canonical.startedAt !== activity.startedAt) {
      this.disposeStream(activity.participantId)
      const visual = activityWithEmptyText(activity)
      const stream = this.createStream(
        activity,
        visual,
        this.machineParticipants.get(activity.participantId)!
      )
      this.streams.set(activity.participantId, stream)
      this.enqueueGrowth(stream, null, activity)
      this.emit({ type: 'activity.updated', activity: visual })
      return
    }
    const previous = current.canonical
    current.canonical = activity
    current.visual = projectActivityText(previous, current.visual, activity, current.queue)
    if (!current.streamFinal) {
      current.visual = activityWithoutFinalText(current.visual)
    }
    this.enqueueGrowth(current, previous, activity)
    this.emit({ type: 'activity.updated', activity: current.visual })
  }

  private createStream(
    canonical: RoomAgentActivity,
    visual: RoomAgentActivity,
    agent: StructuredMachineAgent
  ): ActivityStream {
    let stream: ActivityStream
    const queue = new StreamingTextFrameQueue((deltas) => {
      if (this.streams.get(canonical.participantId) !== stream) {
        return
      }
      stream.visual = appendActivityDeltas(stream.visual, deltas)
      this.emit({ type: 'activity.updated', activity: stream.visual })
    })
    stream = {
      canonical,
      visual,
      queue,
      streamFinal: this.shouldStream(agent),
      ...(agent === 'codex' ? {} : { finalCharsPerSecond: BUFFERED_FINAL_CHARS_PER_SECOND })
    }
    return stream
  }

  private enqueueGrowth(
    stream: ActivityStream,
    previous: RoomAgentActivity | null,
    next: RoomAgentActivity
  ): void {
    for (const message of next.messages) {
      if (message.assistantPhase === 'final' && !stream.streamFinal) {
        continue
      }
      const oldMessage = previous?.messages.find((candidate) => candidate.id === message.id)
      for (const [blockIndex, block] of message.blocks.entries()) {
        if (block.type !== 'text') {
          continue
        }
        const oldBlock = oldMessage?.blocks[blockIndex]
        const oldText = oldBlock?.type === 'text' ? oldBlock.text : ''
        const target = frameTarget(next.participantId, message.id, blockIndex)
        if (block.text.startsWith(oldText)) {
          stream.queue.enqueue(
            target,
            block.text.slice(oldText.length),
            message.assistantPhase === 'final' && stream.finalCharsPerSecond
              ? { charsPerSecond: stream.finalCharsPerSecond }
              : undefined
          )
        } else {
          stream.queue.discard(target)
        }
      }
    }
  }

  private deferUntilDrained(participantId: string, event: RoomEvent): boolean {
    const stream = this.streams.get(participantId)
    if (!stream) {
      return false
    }
    const finish = (): void => {
      this.draining.delete(participantId)
      this.emit(event)
      if (event.type === 'message.created' || event.type === 'activity.cleared') {
        this.disposeStream(participantId)
      }
      const events = this.deferred.get(participantId) ?? []
      this.deferred.delete(participantId)
      for (const deferred of events) {
        this.push(deferred)
      }
    }
    if (stream.queue.drainBefore(finish)) {
      this.draining.add(participantId)
      return true
    }
    finish()
    return true
  }

  private updateMachineParticipants(participants: RoomParticipant[]): void {
    for (const participant of participants) {
      this.updateMachineParticipant(participant)
    }
  }

  private updateMachineParticipant(participant: RoomParticipant): void {
    if (
      participant.providerSession?.transport === 'machine' &&
      participant.agent &&
      isStructuredMachineAgent(participant.agent)
    ) {
      this.machineParticipants.set(participant.id, participant.agent)
    } else {
      this.machineParticipants.delete(participant.id)
      this.disposeStream(participant.id)
    }
  }

  private disposeStream(participantId: string): void {
    this.streams.get(participantId)?.queue.reset()
    this.streams.delete(participantId)
  }

  private reset(): void {
    for (const stream of this.streams.values()) {
      stream.queue.reset()
    }
    this.streams.clear()
    this.draining.clear()
    this.deferred.clear()
  }
}

function eventParticipantId(event: RoomEvent): string | null {
  if (
    event.type === 'activity.updated' ||
    event.type === 'activity.cleared' ||
    event.type === 'participant.updated' ||
    event.type === 'participant.removed'
  ) {
    return event.type === 'activity.updated'
      ? event.activity.participantId
      : event.type === 'participant.updated'
        ? event.participant.id
        : event.participantId
  }
  if (event.type === 'delivery.updated') {
    return event.delivery.participantId
  }
  if (event.type === 'message.created' && event.message.actorKind === 'agent') {
    return event.message.senderId
  }
  return null
}

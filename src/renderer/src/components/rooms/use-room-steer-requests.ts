import { useCallback, useEffect, useMemo, useReducer } from 'react'
import type { RoomDelivery } from '../../../../shared/rooms'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { roomRpc } from '@/runtime/runtime-rooms-client'

type SteerRequest = { promise: Promise<void>; baselines: Map<string, RoomDelivery> }

export function useRoomSteerRequests(
  target: RuntimeClientTarget,
  roomId: string | null,
  deliveries: Record<string, RoomDelivery>
) {
  const scope = useMemo(
    () => ({ roomId, target, requests: new Map<string, SteerRequest>(), active: true }),
    [target, roomId]
  )
  const [, changed] = useReducer((value: number) => value + 1, 0)
  useEffect(() => {
    scope.active = true
    return () => {
      scope.active = false
    }
  }, [scope])

  useEffect(() => {
    let removed = false
    for (const [id, request] of scope.requests) {
      const current = deliveries[id]
      const initial = request.baselines.get(id)!
      if (
        !current ||
        current.state !== initial.state ||
        current.attempts !== initial.attempts ||
        current.intent !== initial.intent ||
        current.error !== initial.error
      ) {
        scope.requests.delete(id)
        removed = true
      }
    }
    if (removed) {
      changed()
    }
  }, [deliveries, scope])

  const steerDelivery = useCallback(
    (deliveryIds: readonly string[], group = false): Promise<void> => {
      const selected = deliveryIds
        .map((id) => deliveries[id])
        .filter((delivery) => delivery !== undefined)
      if (
        !scope.active ||
        !scope.roomId ||
        selected.length !== deliveryIds.length ||
        !selected.length
      ) {
        return Promise.reject(new Error('room_delivery_queue_stale'))
      }
      for (const request of scope.requests.values()) {
        if (
          selected.some((delivery) =>
            [...request.baselines.values()].some(
              (initial) => initial.participantId === delivery.participantId
            )
          )
        ) {
          return request.promise
        }
      }
      const request: SteerRequest = {
        promise: Promise.resolve(),
        baselines: new Map(selected.map((delivery) => [delivery.id, delivery]))
      }
      for (const delivery of selected) {
        scope.requests.set(delivery.id, request)
      }
      changed()
      request.promise = Promise.resolve()
        .then(() =>
          roomRpc(scope.target, 'rooms.deliveries.steer', {
            deliveryId: selected[0]!.id,
            ...(group ? { group: true } : {})
          })
        )
        .then(
          () => {
            // A successful RPC may precede delivery.updated; keep feedback until that event arrives.
          },
          (error) => {
            for (const id of request.baselines.keys()) {
              if (scope.requests.get(id) === request) {
                scope.requests.delete(id)
              }
            }
            if (scope.active) {
              changed()
            }
            throw error
          }
        )
      return request.promise
    },
    [deliveries, scope]
  )

  const pendingSteerIds = new Set(scope.requests.keys())
  return { steerDelivery, pendingSteerIds }
}

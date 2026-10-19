import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import {
  createRejectedNativeFileDropPayload,
  NATIVE_FILE_DROP_MAX_PATHS,
  validateNativeFileDropPaths,
  type NativeFileDropRejectedPayload
} from '../../../shared/native-file-drop'
import {
  OS_FILE_DROP_OWNER_ATTRIBUTE,
  type DroppedPathConsumer,
  type PreparedDroppedPaths
} from '../../../shared/native-file-drop-preparation'
import { hasOsFileDragTypes } from '../lib/os-file-drop-cancellation-guard'

export type OsFileDropSequence = { deliveryTail: Promise<void> }

/** Create once per destination and share across its sibling roots. */
export function createOsFileDropSequence(): OsFileDropSequence {
  return { deliveryTail: Promise.resolve() }
}

type OsFileDropContext<Destination> = {
  target: EventTarget | null
  destination?: Destination
}

type OsFileDropOwnerOptions<Destination> = {
  consumer: DroppedPathConsumer
  sequence: OsFileDropSequence
  canAccept?: boolean | ((event: DragEvent) => boolean)
  captureDestination?: (event: DragEvent) => Destination
  /** Replaces root liveness for paths; preparation failures still reach onDrop. */
  isDestinationLive?: (context: OsFileDropContext<Destination>) => boolean
  onDrop: (
    prepared: PreparedDroppedPaths,
    context: OsFileDropContext<Destination>
  ) => void | Promise<void>
}

const registeredRoots = new WeakMap<HTMLElement, true>()

function isNearestOwner(root: HTMLElement, event: DragEvent): boolean {
  for (const entry of event.composedPath()) {
    if (entry instanceof HTMLElement && registeredRoots.has(entry)) {
      return entry === root
    }
  }
  return false
}

function rejectedDrop(
  reason: NativeFileDropRejectedPayload['reason'],
  pathCount: number,
  byteLength = 0
): PreparedDroppedPaths {
  return { paths: [], failures: [{ target: 'rejected', reason, pathCount, byteLength }] }
}

/** Attach the returned callback ref to the element that owns an OS file drop. */
export function useOsFileDropOwner<Destination = undefined>(
  ownerRef: RefObject<HTMLElement | null>,
  options: OsFileDropOwnerOptions<Destination>
): (root: HTMLElement | null) => void {
  const optionsRef = useRef(options)
  const detachRef = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    optionsRef.current = options
  }, [options])

  return useCallback(
    (root: HTMLElement | null) => {
      detachRef.current?.()
      detachRef.current = null
      ownerRef.current = root
      if (!root) {
        return
      }

      let attached = true
      const canAccept = (event: DragEvent): boolean => {
        const availability = optionsRef.current.canAccept
        return typeof availability === 'function' ? availability(event) : availability !== false
      }

      const onDragOver = (event: DragEvent): void => {
        if (!hasOsFileDragTypes(event.dataTransfer?.types) || !isNearestOwner(root, event)) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = canAccept(event) ? 'copy' : 'none'
        }
      }

      const onDrop = (event: DragEvent): void => {
        if (!hasOsFileDragTypes(event.dataTransfer?.types) || !isNearestOwner(root, event)) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        if (!event.isTrusted) {
          return
        }
        if (!canAccept(event)) {
          return
        }

        const {
          consumer,
          sequence,
          onDrop: deliver,
          captureDestination,
          isDestinationLive
        } = optionsRef.current
        const context: OsFileDropContext<Destination> = { target: event.target }
        if (captureDestination) {
          context.destination = captureDestination(event)
        }
        const queueDelivery = (
          prepared: PreparedDroppedPaths | Promise<PreparedDroppedPaths>
        ): void => {
          sequence.deliveryTail = sequence.deliveryTail
            .then(async () => {
              const result = await prepared
              if (isDestinationLive || attached) {
                await deliver(
                  isDestinationLive && !isDestinationLive(context)
                    ? { ...result, paths: [] }
                    : result,
                  context
                )
              }
            })
            .catch((error: unknown) => console.error('OS file drop owner callback failed', error))
        }
        const files = Array.from(event.dataTransfer?.files ?? [])
        if (files.length > NATIVE_FILE_DROP_MAX_PATHS) {
          queueDelivery({
            paths: [],
            failures: [
              createRejectedNativeFileDropPayload({
                status: 'rejected',
                reason: 'too-many-paths',
                pathCount: files.length,
                byteLength: 0
              })
            ]
          })
          return
        }

        const fs = window.api?.fs
        // The web fallback proxy fabricates methods absent from the concrete namespace.
        const getPathForFile = fs && 'getPathForFile' in fs ? fs.getPathForFile : undefined
        if (!getPathForFile) {
          queueDelivery(rejectedDrop('unresolved-paths', files.length))
          return
        }

        const paths: string[] = []
        for (const file of files) {
          try {
            const path = getPathForFile(file)
            if (path) {
              paths.push(path)
            }
          } catch {
            // A virtual file may not have a local path.
          }
        }
        if (paths.length === 0) {
          queueDelivery(rejectedDrop('unresolved-paths', files.length))
          return
        }

        const unresolvedCount = files.length - paths.length
        const resolutionFailures = unresolvedCount
          ? rejectedDrop('unresolved-paths', unresolvedCount).failures
          : []
        const validation = validateNativeFileDropPaths(paths)
        if (validation.status === 'rejected') {
          queueDelivery({
            paths: [],
            failures: [...resolutionFailures, createRejectedNativeFileDropPayload(validation)]
          })
          return
        }

        const preparation = (async (): Promise<PreparedDroppedPaths> => {
          let prepared: PreparedDroppedPaths
          try {
            prepared = await window.api.fs.prepareDroppedPaths({ paths, consumer })
          } catch {
            prepared = {
              paths: [],
              failures: [
                {
                  target: 'rejected',
                  reason: 'temp-copy-failed',
                  commonReason: 'copy-failed',
                  pathCount: paths.length,
                  byteLength: validation.byteLength
                }
              ]
            }
          }
          return { paths: prepared.paths, failures: [...resolutionFailures, ...prepared.failures] }
        })()
        queueDelivery(preparation)
      }

      root.setAttribute(OS_FILE_DROP_OWNER_ATTRIBUTE, '')
      registeredRoots.set(root, true)
      root.addEventListener('dragover', onDragOver, true)
      root.addEventListener('drop', onDrop, true)
      detachRef.current = () => {
        attached = false
        root.removeEventListener('dragover', onDragOver, true)
        root.removeEventListener('drop', onDrop, true)
        registeredRoots.delete(root)
        root.removeAttribute(OS_FILE_DROP_OWNER_ATTRIBUTE)
      }
    },
    [ownerRef]
  )
}

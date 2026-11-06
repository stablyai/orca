import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import {
  createRejectedNativeFileDropPayload,
  NATIVE_FILE_DROP_MAX_PATHS,
  type NativeFileDropRejectedPayload
} from '../../../shared/native-file-drop'
import {
  OS_FILE_DROP_OWNER_ATTRIBUTE,
  type DroppedPathConsumer,
  type PreparedDroppedPaths
} from '../../../shared/native-file-drop-preparation'
import { prepareOsFileDropPaths } from '../lib/os-file-drop-preparation'
import { hasOsFileDragTypes } from '../lib/os-file-drop-cancellation-guard'
import {
  holdBrowserAttachmentFiles,
  releaseBrowserAttachmentFiles
} from '../lib/browser-attachment-files'

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
  canAccept?: boolean | ((event: DragEvent) => boolean)
  captureDestination?: (event: DragEvent) => Destination
} & (
  | {
      kind: 'files'
      onFiles: (files: File[], context: OsFileDropContext<Destination>) => void
    }
  | {
      kind?: 'paths'
      consumer:
        | DroppedPathConsumer
        | ((destination: Destination | undefined) => DroppedPathConsumer)
      sequence: OsFileDropSequence
      /** Web destinations that upload bytes receive held-file tokens because browser drops have no local paths. */
      acceptsBrowserFiles?: boolean
      /** Replaces root liveness for paths; preparation failures still reach onDrop. */
      isDestinationLive?: (context: OsFileDropContext<Destination>) => boolean
      onDrop: (
        prepared: PreparedDroppedPaths,
        context: OsFileDropContext<Destination>
      ) => void | Promise<void>
    }
)

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

        const currentOptions = optionsRef.current
        const context: OsFileDropContext<Destination> = { target: event.target }
        if (currentOptions.captureDestination) {
          context.destination = currentOptions.captureDestination(event)
        }
        const files = Array.from(event.dataTransfer?.files ?? [])
        if (currentOptions.kind === 'files') {
          currentOptions.onFiles(files, context)
          return
        }
        const { consumer, sequence, onDrop: deliver, isDestinationLive } = currentOptions
        const preparationConsumer =
          typeof consumer === 'function' ? consumer(context.destination) : consumer
        const queueDelivery = (
          prepared: PreparedDroppedPaths | Promise<PreparedDroppedPaths>
        ): void => {
          sequence.deliveryTail = sequence.deliveryTail
            .then(async () => {
              const result = await prepared
              const live = isDestinationLive ? isDestinationLive(context) : attached
              if (isDestinationLive || attached) {
                await deliver(live ? result : { ...result, paths: [] }, context)
              }
              if (!live) {
                // A drop no destination takes must not leave its browser files held.
                releaseBrowserAttachmentFiles(result.paths)
              }
            })
            .catch((error: unknown) => console.error('OS file drop owner callback failed', error))
        }
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
          queueDelivery(
            currentOptions.acceptsBrowserFiles
              ? { paths: holdBrowserAttachmentFiles(files), failures: [] }
              : rejectedDrop('unresolved-paths', files.length)
          )
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
        const preparation = prepareOsFileDropPaths(paths, preparationConsumer).then((prepared) => ({
          paths: prepared.paths,
          failures: [...resolutionFailures, ...prepared.failures]
        }))
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

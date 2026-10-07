import { useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { createOsFileDropSequence, useOsFileDropOwner } from '@/hooks/use-os-file-drop-owner'
import { getNativeFileDropRejectionMessage } from '@/hooks/useGlobalFileDrop'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'

type Args = {
  projectPath?: string | null
  hostId?: ExecutionHostId | null
  connectionId: string | null
  applyDrop?: (paths: string[], isCurrent: () => boolean) => Promise<void>
}

export function useNewWorkspaceComposerFileDrop(args: Args) {
  const ownerRef = useRef<HTMLElement | null>(null)
  const [sequence] = useState(createOsFileDropSequence)
  const mounted = useMountedRef()
  const identity = JSON.stringify([args.projectPath, args.hostId, args.connectionId])
  const identityRef = useRef(identity)
  useLayoutEffect(() => {
    identityRef.current = identity
  }, [identity])
  return useOsFileDropOwner(ownerRef, {
    consumer: 'agent',
    sequence,
    canAccept: Boolean(args.projectPath && args.hostId && args.applyDrop),
    captureDestination: () => {
      const connectionId = args.connectionId
      const host = parseExecutionHostId(args.hostId)
      const currentGeneration = (): number | undefined => {
        if (!connectionId) {
          return undefined
        }
        const state = useAppStore.getState()
        return host?.kind === 'runtime'
          ? state.sshStateByEnvironment?.get(host.environmentId)?.connectionStates.get(connectionId)
              ?.connectionGeneration
          : state.sshConnectionStates.get(connectionId)?.connectionGeneration
      }
      const generation = currentGeneration()
      return {
        applyDrop: args.applyDrop,
        isCurrent: () =>
          mounted.current && identityRef.current === identity && generation === currentGeneration()
      }
    },
    onDrop: async (prepared, { destination }) => {
      if (!destination?.isCurrent()) {
        return
      }
      for (const failure of prepared.failures) {
        const message = getNativeFileDropRejectionMessage(failure)
        toast.error(message.title, { description: message.description })
      }
      if (prepared.paths.length > 0) {
        await destination.applyDrop?.(prepared.paths, destination.isCurrent)
      }
    }
  })
}

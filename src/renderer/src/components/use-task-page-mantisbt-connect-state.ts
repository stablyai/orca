import type { TaskPageMantisBTDetailRoutingModel } from './use-task-page-mantisbt-detail-routing'
import { useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'

export type TaskPageMantisBTConnectStateModel = TaskPageMantisBTDetailRoutingModel & {
  mantisBTConnectOpen: boolean
  setMantisBTConnectOpen: Dispatch<SetStateAction<boolean>>
}

export function useTaskPageMantisBTConnectState(
  model: TaskPageMantisBTDetailRoutingModel
): TaskPageMantisBTConnectStateModel {
  const [mantisBTConnectOpen, setMantisBTConnectOpen] = useState(false)
  return {
    ...model,
    mantisBTConnectOpen,
    setMantisBTConnectOpen
  }
}

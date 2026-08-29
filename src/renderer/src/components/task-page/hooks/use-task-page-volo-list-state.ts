import { useMemo, useState } from 'react'
import type { VoloBoard, VoloTask, VoloTaskFilter } from '../../../../../shared/volo-types'

export function useTaskPageVoloListState() {
  const [voloBoards, setVoloBoards] = useState<VoloBoard[]>([])
  const [voloBoardsLoading, setVoloBoardsLoading] = useState(false)
  const [selectedVoloBoardId, setSelectedVoloBoardId] = useState<string | null>(null)
  const [voloTasks, setVoloTasks] = useState<VoloTask[]>([])
  const [voloLoading, setVoloLoading] = useState(false)
  const [voloError, setVoloError] = useState<string | null>(null)
  const [voloSearchInput, setVoloSearchInput] = useState('')
  const [activeVoloPreset, setActiveVoloPreset] = useState<VoloTaskFilter>('assigned')
  const [voloRefreshNonce, setVoloRefreshNonce] = useState(0)
  const [selectedVoloTask, setSelectedVoloTask] = useState<VoloTask | null>(null)
  const [newVoloTaskOpen, setNewVoloTaskOpen] = useState(false)

  const selectedVoloBoard = useMemo(
    () => voloBoards.find((board) => board.id === selectedVoloBoardId) ?? null,
    [selectedVoloBoardId, voloBoards]
  )

  const displayedVoloTasks = useMemo(() => {
    const query = voloSearchInput.trim().toLowerCase()
    if (!query) {
      return voloTasks
    }
    return voloTasks.filter((task) => {
      return (
        task.taskCode.toLowerCase().includes(query) ||
        task.title.toLowerCase().includes(query) ||
        (task.description ?? '').toLowerCase().includes(query)
      )
    })
  }, [voloSearchInput, voloTasks])

  return {
    voloBoards,
    setVoloBoards,
    voloBoardsLoading,
    setVoloBoardsLoading,
    selectedVoloBoardId,
    setSelectedVoloBoardId,
    selectedVoloBoard,
    voloTasks,
    setVoloTasks,
    voloLoading,
    setVoloLoading,
    voloError,
    setVoloError,
    voloSearchInput,
    setVoloSearchInput,
    activeVoloPreset,
    setActiveVoloPreset,
    voloRefreshNonce,
    setVoloRefreshNonce,
    selectedVoloTask,
    setSelectedVoloTask,
    displayedVoloTasks,
    newVoloTaskOpen,
    setNewVoloTaskOpen
  }
}

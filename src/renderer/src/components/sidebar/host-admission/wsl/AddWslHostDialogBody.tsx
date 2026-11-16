import { useEffect, useState } from 'react'
import { AddWslHostFormPanel, canAddWslDistro, wslHostAddRequest } from './AddWslHostFormPanel'
import { useWslDistroList } from './use-wsl-distro-list'
import { useWslHostServerFilesMissing } from '../../use-wsl-hosts-enabled'
import { readIpcErrorDetail } from '@/runtime/errors/ipc-error'
import { wslHostAddRefusalMessage, wslHostStatusDetailMessage } from '../../wsl-host-failure-text'
import { addWslHostDistro } from './add-wsl-host-distro'

export function AddWslHostDialogBody({
  adding,
  onAddingChange,
  onAdded,
  onCancel
}: {
  adding: boolean
  onAddingChange: (adding: boolean) => void
  onAdded: () => void
  onCancel: () => void
}): React.JSX.Element {
  const serverFilesMissing = useWslHostServerFilesMissing()
  // Missing server files prevent adding any distro, so avoid listing through wsl.exe.
  const list = useWslDistroList(!serverFilesMissing)
  const distros = list.distros
  const [chosenDistro, setChosenDistro] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [wait, setWait] = useState<{ distro: string; text: string } | null>(null)
  // Keep an addable pick or the sole addable distro; never silently choose among several.
  const addable = distros.filter(canAddWslDistro)
  const selectedDistro = addable.some((distro) => distro.name === chosenDistro)
    ? chosenDistro
    : addable.length === 1
      ? addable[0].name
      : ''

  // Main names what a long Add waits for (e.g. another install's lock) instead of a bare spinner.
  useEffect(() => {
    if (!adding) {
      return
    }
    return window.api.runtimeEnvironments?.wslHosts?.onAddProgress?.((progress) => {
      const text = wslHostStatusDetailMessage(progress)
      setWait(text === null ? null : { distro: progress.distro, text })
    })
  }, [adding])
  const addingDetail =
    wait && wait.distro.toLowerCase() === selectedDistro.toLowerCase() ? wait.text : null

  const add = async (): Promise<void> => {
    const selected = distros.find((distro) => distro.name === selectedDistro)
    if (!selected || !canAddWslDistro(selected)) {
      return
    }
    setError(null)
    setWait(null)
    onAddingChange(true)
    try {
      const result = await addWslHostDistro(wslHostAddRequest(selected))
      if (!result.ok) {
        setError(wslHostAddRefusalMessage(result))
        if (result.kind === 'distro-stopped') {
          // It stopped after the list was read; the fresh state turns the button into Start and add.
          list.refresh()
        }
        return
      }
      onAdded()
    } catch (cause) {
      setError(readIpcErrorDetail(cause) ?? String(cause))
    } finally {
      onAddingChange(false)
    }
  }

  return (
    <AddWslHostFormPanel
      distros={distros}
      loading={list.loading}
      refreshing={list.refreshing}
      selectedDistro={selectedDistro}
      error={error ?? list.error}
      adding={adding}
      addingDetail={adding ? addingDetail : null}
      serverFilesMissing={serverFilesMissing}
      onSelectDistro={(name) => {
        setChosenDistro(name)
        setError(null)
      }}
      onRefresh={list.refresh}
      onSubmit={() => void add()}
      onCancel={onCancel}
    />
  )
}

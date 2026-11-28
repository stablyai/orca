import { useEffect, useState } from 'react'
import { AddWslHostFormPanel } from './AddWslHostFormPanel'
import { canAddWslDistro, wslHostAddRequest } from './wsl-host-distro-model'
import { useWslDistroList } from './use-wsl-distro-list'
import { useWslHostServerFilesMissing } from '../../../../runtime/hosts/wsl/use-wsl-hosts-enabled'
import { readIpcErrorDetail } from '@/runtime/errors/ipc-error'
import { wslHostAddRefusalMessage, wslHostStatusDetailMessage } from './wsl-host-failure-text'
import { addWslHostDistro } from './add-wsl-host-distro'
import { runWithFinally } from '@/lib/run-with-finally'

export function AddWslHostDialogBody({
  initialDistro,
  adding,
  onAddingChange,
  onAdded,
  onCancel
}: {
  /** A distro already picked elsewhere (Add host › WSL distro). */
  initialDistro?: string
  adding: boolean
  onAddingChange: (adding: boolean) => void
  onAdded: () => void
  onCancel: () => void
}): React.JSX.Element {
  const serverFilesMissing = useWslHostServerFilesMissing()
  // Missing server files prevent adding any distro, so avoid listing through wsl.exe.
  const list = useWslDistroList(!serverFilesMissing)
  const distros = list.distros
  const [chosenDistro, setChosenDistro] = useState(initialDistro ?? '')
  const [error, setError] = useState<string | null>(null)
  const [addingDistro, setAddingDistro] = useState<string | null>(null)
  const [wait, setWait] = useState<string | null>(null)
  // Keep an addable pick or the sole addable distro; never silently choose among several.
  const addable = distros.filter(canAddWslDistro)
  const selectedDistro = addable.some((distro) => distro.name === chosenDistro)
    ? chosenDistro
    : addable.length === 1
      ? addable[0].name
      : ''

  // Main names what a long Add waits for (e.g. another install's lock) instead of a bare spinner.
  // Every window hears every Add's progress; only this dialog's distro may change its text.
  useEffect(() => {
    if (!adding || addingDistro === null) {
      return
    }
    return window.api.runtimeEnvironments?.wslHosts?.onAddProgress?.((progress) => {
      if (progress.distro.toLowerCase() === addingDistro.toLowerCase()) {
        setWait(wslHostStatusDetailMessage(progress))
      }
    })
  }, [adding, addingDistro])

  const add = async (): Promise<void> => {
    const selected = distros.find((distro) => distro.name === selectedDistro)
    if (!selected || !canAddWslDistro(selected)) {
      return
    }
    setError(null)
    setWait(null)
    setAddingDistro(selected.name)
    onAddingChange(true)
    await runWithFinally(
      async () => {
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
        }
      },
      () => onAddingChange(false)
    )
  }

  return (
    <AddWslHostFormPanel
      distros={distros}
      loading={list.loading}
      refreshing={list.refreshing}
      selectedDistro={selectedDistro}
      error={error ?? list.error}
      adding={adding}
      addingDetail={adding ? wait : null}
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

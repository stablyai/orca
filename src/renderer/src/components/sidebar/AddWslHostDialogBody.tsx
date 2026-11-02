import { useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { AddWslHostFormPanel, canAddWslDistro } from './AddWslHostFormPanel'
import { useWslDistroList } from './use-wsl-distro-list'
import { useWslHostServerFilesMissing } from './use-wsl-hosts-enabled'

/** The "Add WSL distro" step of the add-host dialog; mounted only while it shows. */
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
  // Why no listing without server files: nothing could be added, so no wsl.exe work either.
  const list = useWslDistroList(!serverFilesMissing)
  const distros = list.distros
  const [chosenDistro, setChosenDistro] = useState('')
  const [error, setError] = useState<string | null>(null)
  const setRuntimeEnvironments = useAppStore((s) => s.setRuntimeEnvironments)
  const readRuntimeHostStatusSnapshots = useAppStore((s) => s.readRuntimeHostStatusSnapshots)
  // Derived, so a refresh that drops or adds distros never leaves a stale pick: the user's
  // choice while it can still be added, else the only addable distro (a choice is never implied
  // among several).
  const addable = distros.filter(canAddWslDistro)
  const selectedDistro = addable.some((distro) => distro.name === chosenDistro)
    ? chosenDistro
    : addable.length === 1
      ? addable[0].name
      : ''

  const add = async (): Promise<void> => {
    const api = window.api.runtimeEnvironments?.wslHosts
    const selected = distros.find((distro) => distro.name === selectedDistro)
    if (!api || !selected || !canAddWslDistro(selected)) {
      return
    }
    setError(null)
    onAddingChange(true)
    try {
      // Why startIfStopped: the button said "Start and add", so this click is the user's consent.
      const result = await api.add({
        distro: selected.name,
        startIfStopped: selected.state === 'stopped'
      })
      if (!result.ok) {
        setError(result.message)
        return
      }
      setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
      await readRuntimeHostStatusSnapshots()
      toast.success(
        translate('auto.components.sidebar.AddWslHostDialogBody.added', '{{value0}} added.', {
          value0: selected.name
        })
      )
      onAdded()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
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

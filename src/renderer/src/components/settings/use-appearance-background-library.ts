import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import type { OrcaBackgroundApi } from '../../../../preload/api/orca-background-api'
import type { OrcaBackgroundLibrary } from '../../../../shared/orca-background-library-types'
import { translate } from '@/i18n/i18n'

function getBackgroundsApi(): OrcaBackgroundApi | null {
  return (
    (
      window as Window & {
        api?: { backgrounds?: OrcaBackgroundApi }
      }
    ).api?.backgrounds ?? null
  )
}

export function useAppearanceBackgroundLibrary(onFirstAdded: (fileName: string) => void): {
  library: OrcaBackgroundLibrary
  busy: boolean
  addImages: () => Promise<void>
  openLibrary: () => Promise<void>
} {
  const [library, setLibrary] = useState<OrcaBackgroundLibrary>({ dir: '', images: [] })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const api = getBackgroundsApi()
    if (!api) {
      return
    }
    let alive = true
    void api
      .listLibrary()
      .then((next) => alive && setLibrary(next))
      .catch(() => {
        if (alive) {
          toast.error(
            translate(
              'auto.components.settings.AppearanceBackgroundSection.loadFailed',
              'Could not load the backgrounds library.'
            )
          )
        }
      })
    return () => {
      alive = false
    }
  }, [])

  const addImages = async (): Promise<void> => {
    const api = getBackgroundsApi()
    if (busy || !api) {
      return
    }
    setBusy(true)
    try {
      const next = await api.addImages()
      setLibrary(next)
      if (next.skipped.length > 0) {
        toast.error(
          translate(
            'auto.components.settings.AppearanceBackgroundSection.skipped',
            'Some images could not be added: {{value0}}',
            { value0: next.skipped.join(', ') }
          )
        )
      }
      if (next.added[0]) {
        onFirstAdded(next.added[0])
      }
    } catch {
      toast.error(
        translate(
          'auto.components.settings.AppearanceBackgroundSection.addFailed',
          'Could not add the selected images.'
        )
      )
    } finally {
      setBusy(false)
    }
  }

  const openLibrary = async (): Promise<void> => {
    const api = getBackgroundsApi()
    let opened = false
    try {
      const result = await api?.openLibrary()
      opened = result?.ok === true
    } catch {
      opened = false
    }
    if (opened) {
      return
    }
    toast.error(
      translate(
        'auto.components.settings.AppearanceBackgroundSection.openFailed',
        'Could not open the backgrounds folder.'
      )
    )
  }

  return { library, busy, addImages, openLibrary }
}

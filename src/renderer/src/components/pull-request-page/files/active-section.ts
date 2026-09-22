import { useCallback, useState } from 'react'

export function usePRFileActiveSection(
  entrySignature: string
): [string | null, (key: string | null) => void] {
  const [state, setState] = useState({ entrySignature, key: null as string | null })
  const setActiveSection = useCallback(
    (key: string | null) => setState({ entrySignature, key }),
    [entrySignature]
  )
  return [state.entrySignature === entrySignature ? state.key : null, setActiveSection]
}

import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import { toDisplayUrl } from '../describe-page/browser-page-url-display'

export function useBrowserAddressBarText({
  url,
  addressBarInputRef
}: {
  url: string
  addressBarInputRef: RefObject<HTMLInputElement | null>
}): {
  addressBarValue: string
  setAddressBarValue: Dispatch<SetStateAction<string>>
  committedAddress: string
  setAddressBarValueFromPage: (value: string) => void
  setAddressBarValueFromSubmit: (value: string) => void
} {
  const [committedAddress, setCommittedAddress] = useState(() => toDisplayUrl(url))
  const [addressBarValue, setAddressBarValue] = useState(committedAddress)

  const setAddressBarValueFromPage = useCallback(
    (next: string): void => {
      setCommittedAddress(next)
      if (document.activeElement !== addressBarInputRef.current) {
        setAddressBarValue(next)
      }
    },
    [addressBarInputRef]
  )

  const setAddressBarValueFromSubmit = useCallback((next: string): void => {
    setCommittedAddress(next)
    setAddressBarValue(next)
  }, [])

  const urlAddress = toDisplayUrl(url)
  useEffect(() => {
    setAddressBarValueFromPage(urlAddress)
  }, [setAddressBarValueFromPage, urlAddress])

  return {
    addressBarValue,
    setAddressBarValue,
    committedAddress,
    setAddressBarValueFromPage,
    setAddressBarValueFromSubmit
  }
}

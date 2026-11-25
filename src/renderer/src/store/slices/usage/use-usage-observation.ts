import { useEffect } from 'react'

export function useUsageObservation(observe: () => () => void): void {
  useEffect(() => observe(), [observe])
}

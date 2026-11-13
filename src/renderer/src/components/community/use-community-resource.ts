import { useEffect, useState } from 'react'
export function useCommunityResource<T>(load: () => Promise<T>) {
  const [value, setValue] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let current = true
    setValue(null)
    setError(null)
    void load()
      .then((result) => {
        if (current) {
          setValue(result)
        }
      })
      .catch((cause) => {
        if (current) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
    return () => {
      current = false
    }
  }, [load, revision])
  return { value, error, retry: () => setRevision((v) => v + 1) }
}

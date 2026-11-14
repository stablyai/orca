import { toast } from 'sonner'

export async function pickLocalProjectLocationFolder(
  onPicked: (path: string) => void
): Promise<void> {
  try {
    const path = await window.api.repos.pickFolder()
    if (path) {
      onPicked(path)
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  }
}

import { createRoot, type Root } from 'react-dom/client'

type RendererRootHotData = {
  mcodeRendererRoot?: Root
}

export function getOrCreateRendererRoot(
  container: HTMLElement,
  hotData?: RendererRootHotData
): Root {
  const existingRoot = hotData?.mcodeRendererRoot
  if (existingRoot) {
    return existingRoot
  }
  const root = createRoot(container)
  if (hotData) {
    hotData.mcodeRendererRoot = root
  }
  return root
}

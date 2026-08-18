import { createRoot, type Root } from 'react-dom/client'

type RendererRootHotData = {
  orcaRendererRoot?: Root
}

export function getOrCreateRendererRoot(
  container: HTMLElement,
  hotData?: RendererRootHotData
): Root {
  const existingRoot = hotData?.orcaRendererRoot
  if (existingRoot) {
    return existingRoot
  }
  const root = createRoot(container)
  if (hotData) {
    hotData.orcaRendererRoot = root
  }
  return root
}

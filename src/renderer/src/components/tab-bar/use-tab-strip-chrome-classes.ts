import {
  getActiveTabIndicatorClasses,
  getDropIndicatorClasses,
  getTabStripBorderClasses,
  type DropIndicator
} from './drop-indicator'
import { useTabStripOrientation } from './tab-strip-orientation'

/** Edge chrome for a tab root, which runs along a different side in a vertical strip. */
export function useTabStripChromeClasses(
  hasTabsToRight: boolean,
  includeTopBorder: boolean,
  dropIndicator: DropIndicator
): { edges: string; activeIndicator: string } {
  const orientation = useTabStripOrientation()
  const borders = getTabStripBorderClasses(hasTabsToRight, { includeTopBorder, orientation })
  return {
    edges: `${borders} ${getDropIndicatorClasses(dropIndicator, orientation)}`,
    activeIndicator: getActiveTabIndicatorClasses(orientation)
  }
}

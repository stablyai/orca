import { test } from './helpers/orca-app'
import { multiwindowSearchJourney } from './helpers/multiwindow-search-journey'

test(
  'Jump visits exact native views and opens presentation here/beside with undo and draft recovery',
  multiwindowSearchJourney
)
